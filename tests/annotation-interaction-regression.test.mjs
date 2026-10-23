import { browserSidecarHarnessScript } from "./browser-sidecar-harness.mjs";
import { isInlineResource } from "./inline-toolbar-icons.mjs";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { withTestNetworkFirewall } from "./test-network-firewall.mjs";
import path from "node:path";
import { test } from "node:test";
import puppeteer from "puppeteer-core";
import { resolveBrowserPath } from "./browser-path.mjs";
import {
  attachCleanupErrors,
  cleanupBrowserTestResources,
} from "./browser-test-cleanup.mjs";
import {
  createDiskAdapter,
  createTempRoot,
  loadBundledPlugin,
  pluginRoot,
  readBuiltMain,
  readPayloadFromMain,
  removeTempRoot,
  root,
} from "./bundled-plugin-test-utils.mjs";
import { resolveTestArtifactRoot } from "./test-artifact-root.mjs";

const dist = path.join(root, "dist", "pdf-web-reader");
const fixture = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const artifacts = resolveTestArtifactRoot(root);
const browserPath = resolveBrowserPath();

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

const typeNames = new Map([
  [3, "FreeText"],
  [5, "Square"],
  [9, "Highlight"],
  [10, "Underline"],
  [15, "Ink"],
]);

test(
  "annotation creation tools take priority over existing markup only while creating",
  { timeout: 300_000 },
  async (t) => {
    assert.ok(browserPath, "Set PDF_READER_CHROME to Chrome or Edge");
    await mkdir(artifacts, { recursive: true });

    const mainSource = await readBuiltMain();
    const payload = readPayloadFromMain(mainSource);
    const distFiles = (await import("node:fs/promises")).readdir;
    assert.deepEqual(
      (await distFiles(dist)).sort(),
      ["main.js", "manifest.json", "styles.css"],
      "The test must start from the built three-file plugin",
    );

    const temp = await createTempRoot("annotation-interaction-regression-");
    const adapter = createDiskAdapter(temp);
    const harness = loadBundledPlugin(mainSource, adapter);
    await harness.load();
    const logicalAssetRoot = `${pluginRoot}/.asset-cache/${payload.id}/${payload.contentHash}`;
    const output = adapter.resolve(logicalAssetRoot);
    const captureId = payload.contentHash.slice(0, 12);
    const openTraceRunId = `${Date.now()}-${process.pid}`;
    const artifactId = `${captureId}-${openTraceRunId}`;
    const results = [];
    const errors = [];
    const consoleErrors = [];
    const externalRequests = [];
    const cdpWorkerTrace = { events: [], droppedEvents: 0 };
    const partialArtifactPath = path.join(
      artifacts,
      `annotation-interaction-${artifactId}.partial.json`,
    );
    const failureCaptureErrors = [];
    const cdpWorkerByTargetId = new Map();
    const cdpWorkerBySessionId = new Map();
    const cdpObservedSessions = new WeakSet();
    const cdpNetworkObservedSessions = new WeakSet();
    let cdpEventSequence = 0;
    let cdpWorkerSequence = 0;
    let restoreCDPSend;
    let apiRequestCount = 0;
    let browser;
    let page;
    let server;
    let viewer;
    let functionalError;
    let failureScreenshotPath = null;
    let cleanupReport;
    const recordCDPEvent = (event) => {
      const item = { sequence: ++cdpEventSequence, at: Date.now(), ...event };
      if (cdpWorkerTrace.events.length < 1_500) {
        cdpWorkerTrace.events.push(item);
      } else {
        cdpWorkerTrace.droppedEvents += 1;
      }
    };
    const sanitizeTargetUrl = (value) => {
      if (!value) return null;
      try {
        const url = new URL(String(value));
        return {
          origin: url.origin === "null" ? url.protocol : url.origin,
          path: url.pathname.split("/").filter(Boolean).slice(-3).join("/"),
        };
      } catch {
        return { origin: null, path: String(value).slice(-100) };
      }
    };
    const sessionTargetInfo = (session) => {
      try {
        const target = session?.target?.();
        const info = target?._getTargetInfo?.();
        return {
          type: info?.type ?? target?.type?.() ?? null,
          targetId: info?.targetId ?? target?._targetId ?? null,
          url: sanitizeTargetUrl(info?.url ?? target?.url?.()),
        };
      } catch {
        return { type: null, targetId: null, url: null };
      }
    };
    const observeCDPNetwork = (session) => {
      if (!session || cdpNetworkObservedSessions.has(session)) return;
      cdpNetworkObservedSessions.add(session);
      for (const method of ["Network.requestWillBeSent", "Fetch.requestPaused", "Network.loadingFailed", "Network.loadingFinished"]) {
        session.on(method, (event) => {
          recordCDPEvent({
            kind: "network-event",
            method,
            targetType: sessionTargetInfo(session).type,
            targetId: sessionTargetInfo(session).targetId,
            sessionId: session.id?.() ?? null,
            requestId: event.requestId ?? null,
            networkId: event.networkId ?? null,
            frameId: event.frameId ?? null,
            requestUrl: sanitizeTargetUrl(event.request?.url),
            resourceType: event.type ?? event.resourceType ?? null,
            errorText: String(event.errorText ?? "").slice(0, 180),
          });
        });
      }
    };
    const getOrCreateCDPWorker = (session, explicit = {}) => {
      const info = explicit.targetInfo ?? sessionTargetInfo(session);
      const type = explicit.type ?? info.type;
      if (!["worker", "shared_worker", "service_worker"].includes(type)) {
        return null;
      }
      const targetId = explicit.targetId ?? info.targetId ?? null;
      const sessionId = explicit.sessionId ?? session?.id?.() ?? null;
      let worker = targetId ? cdpWorkerByTargetId.get(targetId) : null;
      if (!worker && sessionId) worker = cdpWorkerBySessionId.get(sessionId);
      if (!worker) {
        worker = {
          workerKey: `cdp-worker-${++cdpWorkerSequence}`,
          type,
          targetId,
          sessionId,
          url: explicit.url ?? info.url ?? null,
        };
      }
      worker.type = type;
      worker.targetId = targetId ?? worker.targetId;
      worker.sessionId = sessionId ?? worker.sessionId;
      worker.url = explicit.url ?? worker.url ?? info.url ?? null;
      if (worker.targetId) cdpWorkerByTargetId.set(worker.targetId, worker);
      if (worker.sessionId) cdpWorkerBySessionId.set(worker.sessionId, worker);
      if (session && !cdpObservedSessions.has(session)) {
        cdpObservedSessions.add(session);
        observeCDPNetwork(session);
        session.on("Runtime.executionContextCreated", (event) => {
          const context = event?.context ?? {};
          recordCDPEvent({
            kind: "runtime-context-created",
            ...worker,
            contextId: context.id ?? null,
            origin: sanitizeTargetUrl(context.origin)?.origin ?? null,
            name: context.name ?? null,
            isDefault: context.auxData?.isDefault ?? null,
            contextType: context.auxData?.type ?? null,
          });
        });
        session.on("Runtime.executionContextDestroyed", (event) => {
          recordCDPEvent({
            kind: "runtime-context-destroyed",
            ...worker,
            contextId: event?.executionContextId ?? null,
          });
        });
        session.on("Runtime.executionContextsCleared", () => {
          recordCDPEvent({ kind: "runtime-contexts-cleared", ...worker });
        });
        session.on("Runtime.exceptionThrown", (event) => {
          const details = event?.exceptionDetails ?? {};
          recordCDPEvent({
            kind: "runtime-exception",
            ...worker,
            exceptionClass: details.exception?.className ?? null,
            text: String(details.text ?? "").slice(0, 240),
            lineNumber: details.lineNumber ?? null,
            columnNumber: details.columnNumber ?? null,
            frames: (details.stackTrace?.callFrames ?? [])
              .slice(0, 5)
              .map((frame) => ({
                functionName: String(frame.functionName ?? "").slice(0, 100),
                url: sanitizeTargetUrl(frame.url),
                lineNumber: frame.lineNumber ?? null,
                columnNumber: frame.columnNumber ?? null,
              })),
          });
        });
        session.on("Inspector.targetCrashed", (event) => {
          recordCDPEvent({
            kind: "inspector-target-crashed",
            ...worker,
            reason: String(event?.reason ?? "").slice(0, 200),
          });
        });
        const onAttached = (event) => {
          const targetInfo = event?.targetInfo ?? {};
          const childSession = session.connection?.()?._session?.(event?.sessionId);
          const child = getOrCreateCDPWorker(childSession, {
            targetInfo,
            sessionId: event?.sessionId,
            targetId: targetInfo.targetId,
            type: targetInfo.type,
            url: sanitizeTargetUrl(targetInfo.url),
          });
          if (child) {
            recordCDPEvent({
              kind: "target-attached",
              ...child,
              parentWorkerKey: worker.workerKey,
              waitingForDebugger: event?.waitingForDebugger ?? null,
            });
          }
        };
        const onDetached = (event) => {
          const child = cdpWorkerBySessionId.get(event?.sessionId);
          if (child) {
            recordCDPEvent({
              kind: "target-detached",
              ...child,
              parentWorkerKey: worker.workerKey,
            });
          }
        };
        session.on("Target.attachedToTarget", onAttached);
        session.on("Target.detachedFromTarget", onDetached);
      }
      return worker;
    };
    const installCDPWorkerTrace = (page) => {
      const client = page._client();
      const connection = client.connection();
      observeCDPNetwork(client);
      const onAttached = (event) => {
        const targetInfo = event?.targetInfo ?? {};
        if (!["worker", "shared_worker", "service_worker"].includes(targetInfo.type)) {
          return;
        }
        const worker = getOrCreateCDPWorker(
          connection?._session?.(event?.sessionId),
          {
            targetInfo,
            sessionId: event?.sessionId,
            targetId: targetInfo.targetId,
            type: targetInfo.type,
            url: sanitizeTargetUrl(targetInfo.url),
          },
        );
        recordCDPEvent({
          kind: "target-attached",
          ...worker,
          waitingForDebugger: event?.waitingForDebugger ?? null,
        });
      };
      const onDetached = (event) => {
        const worker = cdpWorkerBySessionId.get(event?.sessionId);
        if (worker) {
          recordCDPEvent({ kind: "target-detached", ...worker });
        }
      };
      client.on("Target.attachedToTarget", onAttached);
      client.on("Target.detachedFromTarget", onDetached);

      const prototype = Object.getPrototypeOf(client);
      const originalSend = prototype.send;
      const tracedSend = function (method, params, options) {
        const worker = getOrCreateCDPWorker(this);
        const traceCommand =
          method === "Target.setAutoAttach" ||
          ["Runtime.enable", "Runtime.runIfWaitingForDebugger", "Fetch.enable", "Fetch.continueRequest", "Fetch.failRequest"].includes(
            method,
          );
        if (!traceCommand) return originalSend.call(this, method, params, options);

        const targetInfo = sessionTargetInfo(this);
        const eventBase = {
          kind: "cdp-command",
          method,
          targetType: targetInfo.type,
          targetId: targetInfo.targetId,
          sessionId: this.id?.() ?? null,
          requestId: params?.requestId ?? null,
          ...(worker ?? {}),
        };
        const commandId = ++cdpEventSequence;
        recordCDPEvent({
          ...eventBase,
          kind: "cdp-command-start",
          commandId,
          autoAttach: method === "Target.setAutoAttach"
            ? {
                autoAttach: params?.autoAttach ?? null,
                flatten: params?.flatten ?? null,
                waitForDebuggerOnStart:
                  params?.waitForDebuggerOnStart ?? null,
              }
            : undefined,
        });
        if (worker && method === "Runtime.enable") {
          getOrCreateCDPWorker(this);
        }
        let result;
        try {
          result = originalSend.call(this, method, params, options);
        } catch (error) {
          recordCDPEvent({
            ...eventBase,
            kind: "cdp-command-result",
            commandId,
            outcome: "throw",
            errorName: String(error?.name ?? "Error").slice(0, 100),
            errorMessage: String(error?.message ?? error).slice(0, 240),
          });
          throw error;
        }
        Promise.resolve(result).then(
          () =>
            recordCDPEvent({
              ...eventBase,
              kind: "cdp-command-result",
              commandId,
              outcome: "resolved",
            }),
          (error) =>
            recordCDPEvent({
              ...eventBase,
              kind: "cdp-command-result",
              commandId,
              outcome: "rejected",
              errorName: String(error?.name ?? "Error").slice(0, 100),
              errorMessage: String(error?.message ?? error).slice(0, 240),
            }),
        );
        return result;
      };
      prototype.send = tracedSend;
      restoreCDPSend = () => {
        if (prototype.send === tracedSend) prototype.send = originalSend;
      };
    };
    const persistProgress = async () => {
      const traceFrame =
        viewer ??
        (page
          ? page.frames().find((frame) => frame.name() === "pdf-reader")
          : null);
      const hostState = await page?.evaluate(() => {
        const state = window.__hostState;
        if (!state) return null;
        return {
          opened: state.opened ?? null,
          saves: state.saves ?? null,
          readyGenerations: state.readyGenerations?.slice(-20) ?? [],
          opensSent: state.opensSent?.slice(-20) ?? [],
          received: state.received?.slice(-30) ?? [],
          errors: state.errors?.slice(-20) ?? [],
          setupError: state.error ?? null,
        };
      }).catch(() => null);
      const rendererState = await traceFrame?.evaluate(() => {
        const app = window.PDFViewerApplication;
        const task = app?.pdfLoadingTask;
        const worker = task?._worker;
        const pageView = app?.pdfViewer?.getPageView?.(0);
        return {
          documentId: task?.docId ?? null,
          pdfLoaded: Boolean(app?.pdfDocument),
          loadingPercent: app?.loadingBar?.percent ?? null,
          pageNumber: app?.pdfViewer?.currentPageNumber ?? null,
          pageRenderState: pageView?.renderingState ?? null,
          pageLoaded: pageView?.div?.dataset?.loaded ?? null,
          loadingTask: task
            ? {
                destroyed: task.destroyed ?? null,
                transportPresent: Boolean(task._transport),
                workerPresent: Boolean(worker),
                workerDestroyed: worker?.destroyed ?? null,
                workerPortType: worker?.port?.constructor?.name ?? null,
                workerPortClosed: worker?.port?.closed ?? null,
                webWorkerPresent: Boolean(worker?._webWorker),
                workerMessageHandler: worker?.messageHandler
                  ? {
                      sourceName: worker.messageHandler.sourceName ?? null,
                      targetName: worker.messageHandler.targetName ?? null,
                      pendingCallbacks: Object.keys(
                        worker.messageHandler.callbackCapabilities ?? {},
                      ).length,
                    }
                  : null,
              }
            : null,
        };
      }).catch(() => null);
      await writeFile(
        partialArtifactPath,
        JSON.stringify(
          {
            fixture:
              "tests/fixtures/tracemonkey.pdf (read-only public fixture)",
            payloadId: payload.id,
            contentHash: payload.contentHash,
            browserPath,
            openTraceRunId,
            openTrace: await traceFrame?.evaluate(() =>
              window.__pdfOpenTrace?.map((entry) => ({ ...entry })) ?? [],
            ).catch(() => []),
            workerMessages: await traceFrame?.evaluate(() =>
              window.__pdfWorkerMessages?.slice(-200) ?? [],
            ).catch(() => []),
            workerLifecycles: await traceFrame?.evaluate(() =>
              window.__pdfWorkerLifecycles?.slice(-200) ?? [],
            ).catch(() => []),
            hostState,
            rendererState,
            cdpWorkerTrace,
            scenarios: results,
            apiRequestCount,
            externalRequests,
            errors,
            consoleErrors,
            failure: functionalError
              ? {
                  name: functionalError.name ?? "Error",
                  message: String(functionalError.message ?? functionalError).slice(
                    0,
                    4_000,
                  ),
                }
              : null,
            failureScreenshotPath,
            failureCaptureErrors,
          },
          null,
          2,
        ),
        "utf8",
      );
    };

    server = createServer(async (request, response) => {
      for (const [name, value] of Object.entries(withTestNetworkFirewall())) {
        response.setHeader(name, value);
      }
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) apiRequestCount += 1;
      if (url.pathname === "/" || url.pathname === "/favicon.ico") {
        response.writeHead(url.pathname === "/" ? 200 : 204, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(
          url.pathname === "/"
            ? "<!doctype html><title>Annotation interaction regression</title>"
            : undefined,
        );
        return;
      }

      let target;
      if (url.pathname === "/fixtures/tracemonkey.pdf") {
        target = fixture;
      } else if (url.pathname.startsWith("/viewer/")) {
        const relative = decodeURIComponent(
          url.pathname.slice("/viewer/".length),
        );
        target = path.resolve(output, relative);
        if (!target.startsWith(`${output}${path.sep}`)) {
          response.writeHead(403).end("forbidden");
          return;
        }
      } else {
        response.writeHead(404).end("not found");
        return;
      }

      try {
        await access(target);
        const info = await stat(target);
        if (!info.isFile()) {
          response.writeHead(404).end("not found");
          return;
        }
        response.writeHead(200, {
          "content-type":
            mimeTypes.get(path.extname(target)) || "application/octet-stream",
          "content-length": info.size,
          "x-content-type-options": "nosniff",
        });
        createReadStream(target).pipe(response);
      } catch {
        response.writeHead(404).end("not found");
      }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      adapter.getResourcePath = (vaultPath) => {
        const prefix = `${logicalAssetRoot}/`;
        assert.ok(
          vaultPath.startsWith(prefix),
          `Unexpected viewer resource: ${vaultPath}`,
        );
        return new URL(
          `viewer/${vaultPath.slice(prefix.length)}`,
          `${baseUrl}/`,
        ).href;
      };
      const view = harness.createView();
      const viewerDocument = await view.createViewerDocument();
      const viewerLiteral = JSON.stringify(viewerDocument).replaceAll(
        "<",
        "\\u003c",
      );
      browser = await launchTestBrowser(puppeteer, {
        executablePath: browserPath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      }, { testName: "annotation-interaction-regression", artifactsDir: artifacts });
      page = await browser.newPage();
      installCDPWorkerTrace(page);
      await page.evaluateOnNewDocument(() => {
        if (window.parent === window) return;
        window.__pdfOpenTrace = [];
        window.__pdfWorkerMessages = [];
        window.__pdfWorkerLifecycles = [];
        const sanitizeWorkerUrl = (value) => {
          try {
            const url = new URL(String(value), window.location.href);
            return {
              origin: url.origin === "null" ? url.protocol : url.origin,
              path: url.pathname.split("/").filter(Boolean).slice(-3).join("/"),
            };
          } catch {
            return { origin: null, path: String(value).slice(-100) };
          }
        };
        let nextWorkerId = 0;
        if (typeof window.Worker === "function") {
          const NativeWorker = window.Worker;
          window.Worker = new Proxy(NativeWorker, {
            construct(target, args) {
              const worker = Reflect.construct(target, args, target);
              const workerId = ++nextWorkerId;
              const workerUrl = sanitizeWorkerUrl(args[0]);
              const recordLifecycle = (event, extra = {}) => {
                if (window.__pdfWorkerLifecycles.length >= 500) return;
                window.__pdfWorkerLifecycles.push({
                  at: performance.now(),
                  wallTime: Date.now(),
                  workerId,
                  event,
                  workerUrl,
                  workerType: args[1]?.type ?? null,
                  ...extra,
                });
              };
              recordLifecycle("created");
              worker.addEventListener("error", (event) =>
                recordLifecycle("error", {
                  message: String(event?.message ?? "").slice(0, 240),
                  filename: sanitizeWorkerUrl(event?.filename),
                  lineNumber: event?.lineno ?? null,
                  columnNumber: event?.colno ?? null,
                }),
              );
              worker.addEventListener("messageerror", () =>
                recordLifecycle("messageerror"),
              );
              const record = (direction, message) => {
                if (!message || typeof message !== "object") return;
                const action = message.action ?? null;
                const data = message.data;
                if (
                  ![
                    "GetDocRequest",
                    "GetDoc",
                    "DocException",
                    "DataLoaded",
                    "Ready",
                    "ready",
                    "test",
                  ].includes(action) &&
                  !(message.callbackId && message.callback)
                ) {
                  return;
                }
                window.__pdfWorkerMessages.push({
                  at: performance.now(),
                  workerId,
                  direction,
                  sourceName: message.sourceName ?? null,
                  targetName: message.targetName ?? null,
                  action,
                  callbackId: message.callbackId ?? null,
                  callback: message.callback ?? null,
                  docId: data?.docId ?? null,
                  pageCount: data?.pdfInfo?.numPages ?? null,
                  inputByteLength:
                    data?.data?.byteLength ?? data?.data?.length ?? null,
                });
              };
              const nativePostMessage = worker.postMessage.bind(worker);
              worker.postMessage = (message, ...rest) => {
                record("to-worker", message);
                return nativePostMessage(message, ...rest);
              };
              worker.addEventListener("message", (event) =>
                record("from-worker", event.data),
              );
              const nativeTerminate = worker.terminate.bind(worker);
              worker.terminate = () => {
                recordLifecycle("terminated");
                window.__pdfWorkerMessages.push({
                  at: performance.now(),
                  workerId,
                  direction: "terminate",
                });
                return nativeTerminate();
              };
              return worker;
            },
          });
        }
        let nextOpenId = 0;
        window.parent.document.addEventListener(
          "webviewerloaded",
          () => {
            const app = window.PDFViewerApplication;
            if (!app || app.__openTraceInstalled) return;
            app.__openTraceInstalled = true;
            const originalOpen = app.open;
            const taskState = (task) => {
              const worker = task?._worker;
              const messageHandler = task?._transport?.messageHandler;
              return task
                ? {
                    docId: task.docId ?? null,
                    destroyed: task.destroyed ?? null,
                    workerDestroyed: worker?.destroyed ?? null,
                    workerPortType: worker?.port?.constructor?.name ?? null,
                    workerPortClosed: worker?.port?.closed ?? null,
                    webWorkerPresent: Boolean(worker?._webWorker),
                    transportPresent: Boolean(task._transport),
                    transportMessageHandler: messageHandler
                      ? {
                          sourceName: messageHandler.sourceName ?? null,
                          targetName: messageHandler.targetName ?? null,
                          pendingCallbacks: Object.keys(
                            messageHandler.callbackCapabilities ?? {},
                          ).length,
                          actionHandlers: Object.keys(
                            messageHandler.actionHandler ?? {},
                          ),
                          streamSinks: Object.keys(
                            messageHandler.streamSinks ?? {},
                          ).length,
                          streamControllers: Object.keys(
                            messageHandler.streamControllers ?? {},
                          ).length,
                        }
                      : null,
                    workerMessageHandler: worker?.messageHandler
                      ? {
                          sourceName: worker.messageHandler.sourceName ?? null,
                          targetName: worker.messageHandler.targetName ?? null,
                          pendingCallbacks: Object.keys(
                            worker.messageHandler.callbackCapabilities ?? {},
                          ).length,
                          actionHandlers: Object.keys(
                            worker.messageHandler.actionHandler ?? {},
                          ),
                        }
                      : null,
                  }
                : null;
            };
            app.open = function (args) {
              const openId = ++nextOpenId;
              const previousTask = this.pdfLoadingTask;
              const trace = {
                openId,
                startedAt: performance.now(),
                inputByteLength: args?.data?.byteLength ?? args?.data?.length ?? null,
                previousDocId: previousTask?.docId ?? null,
                taskObserved: false,
                taskPromiseSettled: false,
                openPromiseSettled: false,
                taskWait: null,
              };
              window.__pdfOpenTrace.push(trace);
              const openPromise = originalOpen.call(this, args);
              const observeTask = async () => {
                for (let attempt = 0; attempt < 2_000; attempt++) {
                  const task = this.pdfLoadingTask;
                  if (task && task !== previousTask) {
                    trace.taskObserved = true;
                    trace.task = taskState(task);
                    task.promise.then(
                      (pdfDocument) => {
                        trace.taskPromiseSettled = true;
                        trace.taskWait = {
                          outcome: "resolved",
                          pageCount: pdfDocument?.numPages ?? null,
                          at: performance.now(),
                        };
                        trace.taskAfterPromise = taskState(task);
                      },
                      (error) => {
                        trace.taskPromiseSettled = true;
                        trace.taskWait = {
                          outcome: "rejected",
                          message: error?.message ?? String(error),
                          at: performance.now(),
                        };
                        trace.taskAfterPromise = taskState(task);
                      },
                    );
                    return;
                  }
                  await new Promise((resolve) => setTimeout(resolve, 0));
                }
                trace.taskWait = { outcome: "task-not-observed" };
              };
              void observeTask();
              return Promise.resolve(openPromise).then(
                (value) => {
                  trace.openPromiseSettled = true;
                  trace.openOutcome = "resolved";
                  trace.openSettledAt = performance.now();
                  return value;
                },
                (error) => {
                  trace.openPromiseSettled = true;
                  trace.openOutcome = "rejected";
                  trace.openError = error?.message ?? String(error);
                  trace.openSettledAt = performance.now();
                  throw error;
                },
              );
            };
            const originalClose = app.close;
            app.close = function (...args) {
              const trace = window.__pdfOpenTrace.at(-1);
              if (trace && this.pdfLoadingTask) {
                trace.closeStartedAt = performance.now();
                trace.closingDocId = this.pdfLoadingTask.docId ?? null;
                trace.closingTaskDestroyed =
                  this.pdfLoadingTask.destroyed ?? null;
                trace.closingWorkerDestroyed =
                  this.pdfLoadingTask._worker?.destroyed ?? null;
              }
              return originalClose.apply(this, args);
            };
            Promise.resolve(app.initializedPromise).then(() => {
              app.eventBus?._on("documentloaded", (event) => {
                const trace = window.__pdfOpenTrace.at(-1);
                if (trace) {
                  trace.documentLoaded = {
                    at: performance.now(),
                    eventSourceIsApp: event?.source === app,
                    currentDocId: app.pdfLoadingTask?.docId ?? null,
                    pdfLoaded: Boolean(app.pdfDocument),
                  };
                }
              });
              app.eventBus?._on("documenterror", (event) => {
                const trace = window.__pdfOpenTrace.at(-1);
                if (trace) {
                  trace.documentError = {
                    at: performance.now(),
                    message: event?.message ?? null,
                    reason:
                      event?.reason instanceof Error
                        ? event.reason.message
                        : event?.reason ?? null,
                    currentDocId: app.pdfLoadingTask?.docId ?? null,
                  };
                }
              });
            });
          },
          true,
        );
      });
      await page.setViewport({ width: 1400, height: 1000 });
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleErrors.push(message.text());
        }
      });
      page.on("request", (request) => {
        if (!isInlineResource(request.url()) && new URL(request.url()).origin !== baseUrl) {
          externalRequests.push(request.url());
        }
      });
      await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
      await page.setContent(`
        <!doctype html><meta charset="utf-8">
        <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%}</style>
        <iframe name="pdf-reader" title="PDF Web Reader"
          sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts"></iframe>
        ${browserSidecarHarnessScript({ channel: "pdf-web-reader", token: view.token })}
        <script>
          const channel='pdf-web-reader', token=${JSON.stringify(view.token)};
          const documentId='fixtures/tracemonkey.pdf';
          const iframe=document.querySelector('iframe');
          const state=window.__hostState={opened:0,saves:0,savedOperations:[],reviewDraftRequests:[],received:[],opensSent:[],openedMessages:[],saveAcks:[],readyGenerations:[],errors:[]};
          let fixtureBytes;
          const sendOpen=(data,label)=>{
            state.opensSent.push({label,documentId,byteLength:data.byteLength,openRequest:null,rendererGeneration:state.readyGenerations.at(-1)??null});
            // Match the real Host reopen contract: carry the known snapshot
            // (including its verified source hash) into this renderer session.
            const externalAnnotations=window.__browserSidecarHost.snapshotFor(documentId);
            iframe.contentWindow.postMessage({channel,type:'open',token,data,documentId,readOnly:false,autoSave:false,
              ...(externalAnnotations?{externalAnnotations}:{} )},'*',[data]);
          };
          window.addEventListener('message',event=>{
            if(event.source!==iframe.contentWindow)return;
            const message=event.data;
            if(!message||message.channel!==channel||message.token!==token)return;
          state.received.push({type:message.type,documentId:message.documentId??null,requestId:message.requestId??null,sessionId:message.sessionId??null,revision:message.revision??null,openRequest:message.openRequest??null,rendererGeneration:message.rendererGeneration??null,code:message.code??null,message:message.type==='error'?message.message:undefined});
            if(message.type==='learning-review-draft-request') state.reviewDraftRequests.push(structuredClone(message));
            if(message.type==='ready'){
              state.readyGenerations.push(message.rendererGeneration??null);
              const data=fixtureBytes.slice(0);
              sendOpen(data,'initial-ready');
            } else if(message.type==='opened') { state.opened+=1; state.openedMessages.push({documentId:message.documentId??null,sessionId:message.sessionId??null,openRequest:message.openRequest??null,revision:message.revision??null,confirmedRevision:message.confirmedRevision??null,dirty:message.dirty??null,restorePaused:message.restorePaused??null}); }
            else if(message.type==='error') state.errors.push({documentId:message.documentId??null,requestId:message.requestId??null,code:message.code??null,message:message.message??null});
            else if(message.type==='save'){
              state.saves+=1;
              const operations=Array.isArray(message.operations)?message.operations:[];
              state.savedOperations.push({documentId:message.documentId,revision:message.revision,operations:structuredClone(operations)});
              const acknowledgement={channel,type:'saved',token,documentId:message.documentId,requestId:message.requestId,openRequest:message.openRequest,revision:message.revision,external:true,operationCount:operations.length};
              if(operations.length>0)acknowledgement.batchId='annotation-interaction-'+message.requestId;
              for(const field of ['sessionId','rendererGeneration'])if(field in message)acknowledgement[field]=message[field];
              iframe.contentWindow.postMessage(acknowledgement,'*');
              state.saveAcks.push({documentId:message.documentId,requestId:message.requestId,sessionId:message.sessionId??null,revision:message.revision??null,operationCount:operations.length,batchId:acknowledgement.batchId??null});
            }
          });
          window.__reopenSavedData=()=>{
            const data=fixtureBytes.slice(0);
            sendOpen(data,'reopen-source-with-sidecar');
          };
          window.__reopenFixture=()=>{
            const data=fixtureBytes.slice(0);
            sendOpen(data,'reopen-fixture');
          };
          (async()=>{
            fixtureBytes=await fetch('/fixtures/tracemonkey.pdf').then(response=>{
              if(!response.ok)throw new Error('fixture fetch failed');
              return response.arrayBuffer();
            });
            iframe.srcdoc=${viewerLiteral};
          })().catch(error=>state.error=error.message);
        </script>
      `);
      await page.waitForFunction(() => window.__hostState?.opened === 1, {
        timeout: 45_000,
      });
      viewer = page
        .frames()
        .find((frame) => frame.name() === "pdf-reader");
      assert.ok(viewer, "Expected the isolated viewer frame");
      await viewer.waitForSelector(
        '.page[data-page-number="1"] .textLayer span',
      );
      await viewer.waitForFunction(
        () => !document.getElementById("editorUnderlineButton").disabled,
      );
      // Check the locally requested 80% middle-button wheel size against the
      // merged 0.5.20 Viewer, then close it before recording interaction events.
      const wheelCenter = { x: 700, y: 500 };
      await page.mouse.move(wheelCenter.x, wheelCenter.y);
      await page.mouse.down({ button: "middle" });
      await viewer.waitForSelector(".pdfToolWheel");
      const wheelSize = await viewer.$eval(".pdfToolWheel", (element) => ({
        diameter: element.getBoundingClientRect().width,
        center: element.querySelector(".pdfToolWheelCenter").getBoundingClientRect().width,
      }));
      assert.equal(wheelSize.diameter, 192);
      assert.ok(Math.abs(wheelSize.center - 49.92) < 0.1);
      await page.mouse.up({ button: "middle" });
      await page.keyboard.press("Escape");
      assert.equal(await viewer.$(".pdfToolWheel"), null);
      await viewer.evaluate(() => {
        window.__pdfLifecycleEvents = [];
        for (const type of ["documentloaded", "documenterror"]) {
          PDFViewerApplication.eventBus.on(type, (event) => {
            window.__pdfLifecycleEvents.push({
              time: performance.now(),
              type,
              message: event.message ?? null,
              reason:
                event.reason instanceof Error
                  ? event.reason.message
                  : event.reason ?? null,
              pdfLoaded: Boolean(PDFViewerApplication.pdfDocument),
              loadingTaskActive: Boolean(PDFViewerApplication.pdfLoadingTask),
            });
          });
        }
        window.__interactionEvents = [];
        const describe = (element) => {
          if (!element) return null;
          return {
            tag: element.tagName,
            id: element.id || "",
            className:
              typeof element.className === "string" ? element.className : "",
            text: (element.textContent || "").trim().slice(0, 80),
            contentEditable:
              element.getAttribute?.("contenteditable") || null,
            connected: element.isConnected,
          };
        };
        window.__annotationModeEvents = [];
        window.__realKeydownEvents = [];
        PDFViewerApplication.eventBus.on(
          "annotationeditormodechanged",
          (event) => {
            window.__annotationModeEvents.push({
              time: performance.now(),
              mode: event.mode,
              isFromKeyboard: event.isFromKeyboard,
              isTemporary: event.isTemporary,
            });
          },
        );
        document.addEventListener(
          "keydown",
          (event) => {
            if (!event.isTrusted) return;
            window.__realKeydownEvents.push({
              time: performance.now(),
              key: event.key,
              code: event.code,
              target: describe(event.target),
              activeElement: describe(document.activeElement),
              defaultPrevented: event.defaultPrevented,
            });
          },
          true,
        );
        for (const type of [
          "pointerdown",
          "pointermove",
          "pointerup",
          "mousedown",
          "mouseup",
          "click",
          "dblclick",
        ]) {
          document.addEventListener(
            type,
            (event) => {
              if (
                type === "pointermove" &&
                "buttons" in event &&
                event.buttons === 0
              ) {
                return;
              }
              const hit = document.elementFromPoint(
                event.clientX,
                event.clientY,
              );
              const layer = document.querySelector(
                '.page[data-page-number="1"] .annotationEditorLayer',
              );
              const selectedFreeTextEditor = layer?.querySelector(
                ".freeTextEditor.selectedEditor",
              );
              window.__interactionEvents.push({
                time: performance.now(),
                type,
                trusted: event.isTrusted,
                target: describe(event.target),
                hit: describe(hit),
                hitInSelectedFreeTextInternal: Boolean(
                  (() => {
                    const internal = layer?.querySelector(
                      ".freeTextEditor.selectedEditor .internal",
                    );
                    return internal && (hit === internal || internal.contains(hit));
                  })(),
                ),
                targetInSelectedFreeTextEditor: Boolean(
                  selectedFreeTextEditor &&
                    (event.target === selectedFreeTextEditor ||
                      selectedFreeTextEditor.contains(event.target)),
                ),
                hitInSelectedFreeTextEditor: Boolean(
                  selectedFreeTextEditor &&
                    (hit === selectedFreeTextEditor ||
                      selectedFreeTextEditor.contains(hit)),
                ),
                point: { x: event.clientX, y: event.clientY },
                buttons: event.buttons,
                pointerId: event.pointerId,
                stack: document
                  .elementsFromPoint(event.clientX, event.clientY)
                  .slice(0, 4)
                  .map(describe),
                targetInTextLayer: Boolean(
                  event.target.closest?.(".textLayer"),
                ),
                targetInEditorLayer: Boolean(
                  event.target.closest?.(".annotationEditorLayer"),
                ),
                layerClass: layer?.className || "",
                drawingChildren: [...(layer?.children || [])]
                  .filter((element) => element.classList.contains("drawing"))
                  .map((element) => element.id),
                mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
              });
            },
            true,
          );
        }
        for (const type of [
          "focusin",
          "focusout",
          "keydown",
          "keyup",
          "beforeinput",
          "input",
        ]) {
          document.addEventListener(
            type,
            (event) => {
              const target =
                event.target instanceof Element
                  ? event.target
                  : event.target?.parentElement;
              if (!target?.closest(".annotationEditorLayer")) return;
              window.__interactionEvents.push({
                time: performance.now(),
                type,
                trusted: event.isTrusted,
                target: describe(target),
                activeElement: describe(document.activeElement),
                relatedTarget: describe(event.relatedTarget),
                key: event.key || null,
                data: event.data ?? null,
                inputType: event.inputType || null,
                defaultPrevented: event.defaultPrevented,
              });
            },
            true,
          );
        }
        document.addEventListener(
          "selectionchange",
          () => {
            const selection = document.getSelection();
            const text = selection?.toString() || "";
            if (text) {
              window.__interactionEvents.push({
                time: performance.now(),
                type: "selectionchange",
                text,
                anchor: describe(selection?.anchorNode?.parentElement),
                focus: describe(selection?.focusNode?.parentElement),
              });
            }
          },
          true,
        );
      });

      const readIframeBox = () => page.$eval("iframe", (iframe) => {
        const rect = iframe.getBoundingClientRect();
        return { x: rect.x, y: rect.y };
      });
      let iframeBox = await readIframeBox();
      const mouseMove = async (start, end, steps = 10) => {
        iframeBox = await readIframeBox();
        await page.mouse.move(iframeBox.x + start.x, iframeBox.y + start.y, {
          steps: 2,
        });
        await page.mouse.down({ button: "left" });
        await page.mouse.move(iframeBox.x + end.x, iframeBox.y + end.y, {
          steps,
        });
        await page.mouse.up({ button: "left" });
      };
      const mouseInkStroke = async (rect) => {
        iframeBox = await readIframeBox();
        const points = [
          { x: rect.x + 8, y: rect.y + 4 },
          { x: rect.x + rect.width * 0.25, y: rect.y + rect.height * 0.25 },
          { x: rect.x + rect.width * 0.52, y: rect.y + rect.height * 0.5 },
          { x: rect.x + rect.width * 0.77, y: rect.y + rect.height * 0.72 },
          { x: rect.x + rect.width - 8, y: rect.bottom - 4 },
        ];
        await page.mouse.move(
          iframeBox.x + points[0].x,
          iframeBox.y + points[0].y,
          {
            steps: 2,
          },
        );
        await page.mouse.down({ button: "left" });
        for (const point of points.slice(1)) {
          await page.mouse.move(iframeBox.x + point.x, iframeBox.y + point.y, {
            steps: 5,
          });
        }
        await page.mouse.up({ button: "left" });
      };
      const setMode = async (mode) => {
        let stage = "target-ready";
        try {
          await viewer.waitForFunction(() => {
            const app = window.PDFViewerApplication;
            const page = document.querySelector(
              '.page[data-page-number="1"]',
            );
            const pageView = app?.pdfViewer?.getPageView(0);
            const layer = pageView?.annotationEditorLayer?.div;
            const manager =
              app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
            const squareButton = document.getElementById("editorSquareButton");
            return (
              app?.pdfDocument &&
              page?.dataset.loaded === "true" &&
              !page.classList.contains("loading") &&
              !page.classList.contains("loadingIcon") &&
              pageView?.pdfPage &&
              pageView.renderingState === 3 &&
              pageView.textLayer?.div?.isConnected &&
              layer?.isConnected &&
              manager &&
              squareButton?.isConnected &&
              !squareButton.disabled
            );
          }, { timeout: 8_000 });
          stage = "mode-change";
          await viewer.evaluate((value) => {
            PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
              mode: value,
            });
          }, mode);
          await viewer.waitForFunction(
            (value) =>
              PDFViewerApplication.pdfViewer.annotationEditorMode === value,
            { timeout: 8_000 },
            mode,
          );
        } catch (error) {
          const renderer = await viewer.evaluate((requestedMode) => {
            const app = window.PDFViewerApplication;
            const page = document.querySelector(
              '.page[data-page-number="1"]',
            );
            const pageView = app?.pdfViewer?.getPageView(0);
            const layer = pageView?.annotationEditorLayer?.div;
            const squareButton = document.getElementById("editorSquareButton");
            const buttonRect = squareButton?.getBoundingClientRect();
            const buttonHit = buttonRect
              ? document.elementFromPoint(
                  buttonRect.x + buttonRect.width / 2,
                  buttonRect.y + buttonRect.height / 2,
                )
              : null;
            return {
              requestedMode,
              currentMode: app?.pdfViewer?.annotationEditorMode ?? null,
              pdfLoaded: Boolean(app?.pdfDocument),
              page: {
                loaded: page?.dataset.loaded ?? null,
                className: page?.className ?? null,
                renderState: pageView?.renderingState ?? null,
                pageReady: Boolean(pageView?.pdfPage),
                textLayerConnected: Boolean(pageView?.textLayer?.div?.isConnected),
                editorLayerConnected: Boolean(layer?.isConnected),
              },
              editorManagerReady: Boolean(
                app?.pdfViewer?._layerProperties?.annotationEditorUIManager,
              ),
              squareButton: squareButton
                ? {
                    disabled: squareButton.disabled,
                    connected: squareButton.isConnected,
                    rect: buttonRect
                      ? {
                          x: buttonRect.x,
                          y: buttonRect.y,
                          width: buttonRect.width,
                          height: buttonRect.height,
                        }
                      : null,
                    hit: buttonHit
                      ? {
                          tag: buttonHit.tagName,
                          id: buttonHit.id || "",
                          className:
                            typeof buttonHit.className === "string"
                              ? buttonHit.className
                              : "",
                        }
                      : null,
                  }
                : null,
              modeEvents: window.__annotationModeEvents?.slice(-20) ?? [],
              realKeydowns: window.__realKeydownEvents?.slice(-20) ?? [],
              recentPointerOrInputEvents:
                window.__interactionEvents
                  ?.filter((event) =>
                    ["pointerdown", "pointerup", "click", "keydown", "input"].includes(
                      event.type,
                    ),
                  )
                  .slice(-30) ?? [],
              activeElement: {
                tag: document.activeElement?.tagName ?? null,
                id: document.activeElement?.id ?? null,
                className:
                  typeof document.activeElement?.className === "string"
                    ? document.activeElement.className
                    : "",
              },
            };
          }, mode);
          const host = await page.evaluate(() => ({
            opened: window.__hostState?.opened,
            saves: window.__hostState?.saves,
            savedOperationCount:
              window.__hostState?.savedOperations?.reduce((count, row) => count + row.operations.length, 0) ?? 0,
            errors: window.__hostState?.errors ?? [],
          }));
          const diagnostic = {
            scenario: "annotation-mode-change-failure",
            stage,
            renderer,
            host,
            message: error.message,
          };
          results.push(diagnostic);
          await persistProgress();
          throw new Error(
            `${error.message}; mode diagnostic: ${JSON.stringify(diagnostic)}`,
          );
        }
      };
      const storageCounts = async () =>
        viewer.evaluate(() => {
          const entries = [
            ...(PDFViewerApplication.pdfDocument.annotationStorage.serializable.map?.values() ||
              []),
          ].filter((entry) => !entry.deleted);
          return Object.fromEntries(
            [3, 5, 9, 10, 15].map((type) => [
              type,
              entries.filter((entry) => entry.annotationType === type).length,
            ]),
          );
        });
      const sidecarSubtypeCounts = async () =>
        page.evaluate(() => {
          const snapshot = window.__browserSidecarHost.snapshotFor(
            "fixtures/tracemonkey.pdf",
          );
          const annotations = snapshot?.annotations ?? [];
          return Object.fromEntries(
            ["FreeText", "Square", "Highlight", "Underline", "Ink"].map(
              (kind) => [
                kind,
                annotations.filter((annotation) => annotation.kind === kind)
                  .length,
              ],
            ),
          );
        });
      const clearProbe = async () =>
        viewer.evaluate(() => {
          window.__interactionEvents.length = 0;
          document.getSelection()?.removeAllRanges();
        });
      const waitForNewAnnotation = async (type, previousCount) =>
        viewer.waitForFunction(
          (annotationType, previous) => {
            const entries = [
              ...(PDFViewerApplication.pdfDocument.annotationStorage.serializable.map?.values() ||
                []),
            ].filter(
              (entry) =>
                entry.annotationType === annotationType && !entry.deleted,
            );
            return entries.length > previous;
          },
          { timeout: 12_000 },
          type,
          previousCount,
        );
      const phraseGeometry = async (
        phrase = "Dynamic languages such as JavaScript",
      ) =>
        viewer.evaluate((targetPhrase) => {
          const spans = [
            ...document.querySelectorAll(
              '.page[data-page-number="1"] .textLayer span',
            ),
          ];
          const span = spans.find((node) =>
            node.textContent.includes(targetPhrase),
          );
          const node = span?.firstChild;
          if (!node || node.nodeType !== Node.TEXT_NODE) {
            throw new Error(`Could not find text-node phrase: ${targetPhrase}`);
          }
          const from = node.textContent.indexOf(targetPhrase);
          const to = from + targetPhrase.length;
          const charRect = (offset) => {
            const range = document.createRange();
            range.setStart(node, offset);
            range.setEnd(node, offset + 1);
            const rect = range.getBoundingClientRect();
            return {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            };
          };
          const first = charRect(from);
          const last = charRect(to - 1);
          const range = document.createRange();
          range.setStart(node, from);
          range.setEnd(node, to);
          const rect = range.getBoundingClientRect();
          const describeHit = (x, y) => {
            const hit = document.elementFromPoint(x, y);
            return {
              tag: hit?.tagName ?? null,
              className: typeof hit?.className === "string" ? hit.className : "",
              text: hit?.textContent?.slice(0, 100) ?? "",
            };
          };
          const box = {
            x: rect.x,
            y: rect.y,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          };
          return {
            phrase: targetPhrase,
            rect: box,
            start: {
              x: first.left + Math.min(1, (first.right - first.left) / 2),
              y: (first.top + first.bottom) / 2,
            },
            end: {
              x: last.right - Math.min(1, (last.right - last.left) / 2),
              y: (last.top + last.bottom) / 2,
            },
            textSelectionProbe: {
              nodeText: node.textContent,
              from,
              to,
              firstChar: first,
              lastChar: last,
              rangeClientRects: [...range.getClientRects()].map((item) => ({
                left: item.left,
                right: item.right,
                top: item.top,
                bottom: item.bottom,
              })),
              startHit: describeHit(
                first.left + Math.min(1, (first.right - first.left) / 2),
                (first.top + first.bottom) / 2,
              ),
              endHit: describeHit(
                last.right - Math.min(1, (last.right - last.left) / 2),
                (last.top + last.bottom) / 2,
              ),
            },
          };
        }, phrase);
      const squareEditors = async () =>
        viewer.evaluate(() => {
          const storage = PDFViewerApplication.pdfDocument.annotationStorage;
          return [
            ...document.querySelectorAll(
              '.page[data-page-number="1"] .annotationEditorLayer .inkEditor',
            ),
          ]
            .filter((element) => {
              const editor = storage.getRawValue(element.id);
              return editor?.constructor?._editorType === 5;
            })
            .map((element) => {
              const editor = storage.getRawValue(element.id);
              const rect = element.getBoundingClientRect();
              return {
                id: element.id,
                uid: editor.uid,
                annotationElementId: editor.annotationElementId || null,
                className: element.className,
                rect: {
                  x: rect.x,
                  y: rect.y,
                  right: rect.right,
                  bottom: rect.bottom,
                  width: rect.width,
                  height: rect.height,
                },
              };
            });
        });
      const waitForSquareHitReady = async (square) => {
        const point = {
          x: square.rect.x + square.rect.width / 2,
          y: square.rect.y + square.rect.height / 2,
          editorId: square.id,
          uid: square.uid,
        };
        try {
          await viewer.waitForFunction(
          ({ x, y, editorId, uid }) => {
            const page = document.querySelector(
              '.page[data-page-number="1"]',
            );
            if (
              !page ||
              page.classList.contains("loading") ||
              page.classList.contains("loadingIcon")
            ) {
              return false;
            }
            const editor = document.getElementById(editorId);
            const rawEditor = PDFViewerApplication.pdfDocument.annotationStorage
              .getRawValue(editorId);
            const hit = document.elementFromPoint(x, y);
            return !!editor && editor.isConnected &&
              editor.classList.contains("inkEditor") &&
              rawEditor?.constructor?._editorType === 5 && rawEditor.uid === uid &&
              hit?.closest(".inkEditor") === editor;
          },
          { timeout: 30_000 },
          point,
          );
        } catch (error) {
          const diagnostic = await viewer.evaluate(({ x, y, editorId }) => {
            const editor = document.getElementById(editorId);
            const rect = editor?.getBoundingClientRect();
            const hit = document.elementFromPoint(x, y);
            return {
              point: { x, y },
              mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
              editor: editor ? {
                id: editor.id,
                className: editor.className,
                connected: editor.isConnected,
                rect: rect ? {
                  x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
                  width: rect.width, height: rect.height,
                } : null,
                style: {
                  display: getComputedStyle(editor).display,
                  visibility: getComputedStyle(editor).visibility,
                  opacity: getComputedStyle(editor).opacity,
                  pointerEvents: getComputedStyle(editor).pointerEvents,
                },
              } : null,
              hit: hit ? {
                tag: hit.tagName, id: hit.id, className: hit.className,
              } : null,
              stack: document.elementsFromPoint(x, y).slice(0, 8).map((element) => ({
                tag: element.tagName, id: element.id, className: element.className,
              })),
            };
          }, point);
          throw new Error(`${error.message}; sidecar Square hit diagnostic=${JSON.stringify(diagnostic)}`);
        }
      };
      const getTextDragPoints = async (
        phrase = "Dynamic languages such as JavaScript",
      ) => {
        const geometry = await phraseGeometry(phrase);
        return viewer.evaluate((target) => {
          const layer = document.querySelector(
            '.page[data-page-number="1"] .annotationEditorLayer',
          );
          const xLeft = target.start.x;
          const xRight = target.end.x;
          const overlays = [...(layer?.children || [])].map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName,
              className: element.className,
              rect: {
                x: rect.x,
                y: rect.y,
                right: rect.right,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
              },
            };
          });
          const overlapping = overlays.find(
            ({ rect }) =>
              rect.width > 0 &&
              rect.height > 0 &&
              rect.x <= xLeft &&
              rect.right >= xRight &&
              Math.min(rect.bottom, target.rect.bottom) >
                Math.max(rect.y, target.rect.y),
          );
          let y = (target.start.y + target.end.y) / 2;
          if (overlapping) {
            const top = Math.max(overlapping.rect.y, target.rect.y);
            const bottom = Math.min(overlapping.rect.bottom, target.rect.bottom);
            const height = bottom - top;
            const candidates = Array.from({ length: 17 }, (_, index) =>
              top + (height * (index + 0.5)) / 17,
            );
            const hitText = (x, candidateY) =>
              document.elementsFromPoint(x, candidateY).find((element) =>
                element.tagName === "SPAN" && element.closest(".textLayer"),
              )?.textContent ?? "";
            const validY = candidates.find((candidateY) => {
              const startText = hitText(target.start.x, candidateY);
              const endText = hitText(target.end.x, candidateY);
              return startText.includes(target.phrase) && endText.includes(target.phrase);
            });
            if (validY === undefined) {
              throw new Error(
                `No text-hit point overlaps the existing ${overlapping.className} for ${target.phrase}; intersection=${JSON.stringify({ top, bottom, start: target.start, end: target.end, candidates: candidates.map((candidateY) => ({ y: candidateY, start: hitText(target.start.x, candidateY), end: hitText(target.end.x, candidateY) })) })}`,
              );
            }
            y = validY;
          }
          const start = { ...target.start, y };
          const end = { ...target.end, y };
          const describe = (element) =>
            element
              ? {
                  tag: element.tagName,
                  id: element.id || "",
                  className:
                    typeof element.className === "string"
                      ? element.className
                      : "",
                }
              : null;
          return {
            ...target,
            start,
            end,
            overlappingEditor: overlapping || null,
            plannedStartHit: document
              .elementsFromPoint(start.x, start.y)
              .slice(0, 5)
              .map(describe),
            plannedEndHit: document
              .elementsFromPoint(end.x, end.y)
              .slice(0, 5)
              .map(describe),
          };
        }, geometry);
      };
      const eventSummary = async () =>
        viewer.evaluate(() => ({
          events: [...window.__interactionEvents],
          selection: document.getSelection()?.toString() || "",
          mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
        }));
      const openCount = async () =>
        page.evaluate(() => window.__hostState.opened);
      const saveCount = async () =>
        page.evaluate(() => window.__hostState.saves);
      const waitForOpenCount = async (expected, context) => {
        try {
          await page.waitForFunction(
            (count) => window.__hostState.opened === count,
            { timeout: 60_000 },
            expected,
          );
        } catch (error) {
          const host = await page.evaluate(() => {
            const state = window.__hostState;
            return {
              opened: state.opened,
              saves: state.saves,
              savedOperationCount: state.savedOperations.reduce((count,row)=>count+row.operations.length,0),
              readyGenerations: state.readyGenerations,
              opensSent: state.opensSent,
              openedMessages: state.openedMessages,
              saveAcks: state.saveAcks,
              received: state.received.slice(-20),
              errors: state.errors,
            };
          });
          const renderer = await viewer.evaluate(() => {
            const app = window.PDFViewerApplication;
            const page = document.querySelector(
              '.page[data-page-number="1"]',
            );
            return {
              title: document.title,
              pdfLoaded: Boolean(app?.pdfDocument),
              pageCount: app?.pdfDocument?.numPages ?? null,
              loadingTaskActive: Boolean(app?.pdfLoadingTask),
              loadingTask: app?.pdfLoadingTask
                ? {
                    docId: app.pdfLoadingTask.docId ?? null,
                    destroyed: app.pdfLoadingTask.destroyed ?? null,
                    workerDestroyed:
                      app.pdfLoadingTask._worker?.destroyed ?? null,
                    workerPortType:
                      app.pdfLoadingTask._worker?.port?.constructor?.name ?? null,
                    workerPortClosed:
                      app.pdfLoadingTask._worker?.port?.closed ?? null,
                    transportPresent: Boolean(app.pdfLoadingTask._transport),
                    transportMessageHandlerPresent: Boolean(
                      app.pdfLoadingTask._transport?.messageHandler,
                    ),
                  }
                : null,
              openTrace: window.__pdfOpenTrace?.map((entry) => ({ ...entry })) ?? [],
              workerMessages:
                window.__pdfWorkerMessages?.slice(-200) ?? [],
              workerLifecycles:
                window.__pdfWorkerLifecycles?.slice(-200) ?? [],
              lifecycleEvents:
                window.__pdfLifecycleEvents?.slice(-20) ?? [],
              loadingPercent: app?.loadingBar?.percent ?? null,
              hasChanges: app?._hasChanges?.() ?? null,
              saveInProgress: app?._saveInProgress ?? null,
              overwriteInProgress: app?._overwriteInProgress ?? null,
              documentEvents: window.__pdfLifecycleEvents?.slice(-20) ?? [],
              bridgeStatus: document.getElementById("pdfReaderBridgeStatus")?.textContent ?? null,
              errorWrapper: document.getElementById("errorWrapper")?.textContent?.trim() ?? null,
              bridgeScript: (() => {
                const script = document.querySelector("script[data-renderer-generation]");
                return script ? {
                  rendererGeneration: script.dataset.rendererGeneration,
                  channel: script.dataset.channel,
                  tokenPresent: Boolean(script.dataset.token),
                } : null;
              })(),
              pageClass: page?.className ?? null,
              pageLoaded: page?.dataset.loaded ?? null,
              selectedEditorCount: document.querySelectorAll(
                ".annotationEditorLayer .selectedEditor",
              ).length,
              activeElement: {
                tag: document.activeElement?.tagName ?? null,
                id: document.activeElement?.id ?? null,
                className:
                  typeof document.activeElement?.className === "string"
                    ? document.activeElement.className
                    : "",
              },
            };
          });
          const diagnostic = {
            scenario: "open-ack-timeout-diagnostic",
            context,
            expectedOpened: expected,
            host,
            renderer,
            openTraceRunId,
            cdpWorkerTrace,
            pageErrors: errors.slice(-20),
            consoleErrors: consoleErrors.slice(-20),
          };
          results.push(diagnostic);
          await persistProgress();
          throw new Error(
            `${error.message}; open diagnostic: ${JSON.stringify(diagnostic)}`,
          );
        }
      };
      const saveDirtySessionBeforeOpen = async () => {
        const dirty = await viewer.evaluate(
          () => PDFViewerApplication._hasChanges(),
        );
        if (!dirty) return;
        const expectedSave = (await saveCount()) + 1;
        await viewer.evaluate(() => PDFViewerApplication.overwriteOriginal());
        await page.waitForFunction(
          (count) => window.__hostState.saves === count,
          { timeout: 60_000 },
          expectedSave,
        );
        await viewer.waitForFunction(
          () =>
            !PDFViewerApplication._hasChanges() &&
            !PDFViewerApplication._saveInProgress,
          { timeout: 60_000 },
        );
      };
      const waitForCurrentPageRendered = async () =>
        viewer.waitForFunction(
          async () => {
            const application = window.PDFViewerApplication;
            const pdfDocument = application?.pdfDocument;
            if (
              !pdfDocument ||
              pdfDocument === window.__previousPdfDocument
            ) {
              return false;
            }
            const page = await pdfDocument.getPage(1);
            const pageView = application.pdfViewer.getPageView(0);
            const pageElement = document.querySelector(
              '.page[data-page-number="1"]',
            );
            return (
              pageView?.pdfPage === page &&
              pageView.renderingState === 3 &&
              pageView.div === pageElement &&
              pageElement?.dataset.loaded === "true" &&
              !pageElement.classList.contains("loading") &&
              !pageElement.classList.contains("loadingIcon") &&
              pageView.textLayer?.div?.isConnected &&
              pageView.textLayer.div.querySelector(".endOfContent") &&
              pageView.annotationEditorLayer?.div?.isConnected
            );
          },
          { timeout: 60_000 },
        );
      const reopenFixture = async () => {
        await saveDirtySessionBeforeOpen();
        const expected = (await openCount()) + 1;
        await viewer.evaluate(() => {
          window.__previousPdfDocument = PDFViewerApplication.pdfDocument;
        });
        await page.evaluate(() => window.__reopenFixture());
        await waitForOpenCount(expected, "fixture");
        await waitForCurrentPageRendered();
      };
      const reopenSavedData = async () => {
        await saveDirtySessionBeforeOpen();
        const expected = (await openCount()) + 1;
        await viewer.evaluate(() => {
          window.__previousPdfDocument = PDFViewerApplication.pdfDocument;
        });
        await page.evaluate(() => window.__reopenSavedData());
        await waitForOpenCount(expected, "saved-data");
        await waitForCurrentPageRendered();
      };
      const saveAndReopen = async () => {
        const expectedSave = (await saveCount()) + 1;
        await viewer.evaluate(() => {
          if (
            document
              .getElementById("secondaryToolbar")
              .classList.contains("hidden")
          ) {
            document.getElementById("secondaryToolbarToggleButton").click();
          }
        });
        await viewer.waitForSelector("#secondaryToolbar:not(.hidden)");
        await viewer.click("#secondaryDownload");
        await page.waitForFunction(
          (count) => window.__hostState.saves === count,
          { timeout: 60_000 },
          expectedSave,
        );
        await viewer.waitForFunction(
          () => !PDFViewerApplication._saveInProgress,
          { timeout: 60_000 },
        );
        await viewer.waitForFunction(
          () => !PDFViewerApplication._hasChanges(),
          { timeout: 60_000 },
        );
        const savedState = await page.evaluate((index) => {
          const save = window.__hostState.savedOperations[index];
          const snapshot = window.__browserSidecarHost.snapshotFor(save.documentId);
          return {
            documentId: save?.documentId ?? null,
            revision: save?.revision ?? null,
            operations: save?.operations ?? [],
            snapshotRevision: snapshot?.revision ?? null,
            activeAnnotations: snapshot?.annotations ?? [],
          };
        }, expectedSave - 1);
        assert.equal(savedState.documentId, "fixtures/tracemonkey.pdf");
        assert.ok(savedState.operations.length > 0, JSON.stringify(savedState));
        assert.ok(savedState.snapshotRevision >= savedState.revision, JSON.stringify(savedState));
        assert.ok(
          savedState.activeAnnotations.every((operation) =>
            typeof operation.uuid === "string" && operation.uuid.length > 0 &&
              Number.isInteger(operation.pageIndex) && operation.pageIndex >= 0 &&
              typeof operation.kind === "string" && operation.payload &&
              typeof operation.payload === "object"),
          "The durable sidecar snapshot must retain complete annotation operation identity and payloads",
        );
        await reopenSavedData();
        return { operationCount: savedState.operations.length, save: expectedSave };
      };
      const createSquareAroundText = async (phrase) => {
        const target = await phraseGeometry(phrase);
        const before = await storageCounts();
        await clearProbe();
        await setMode(5);
        await mouseMove(
          { x: target.rect.x - 3, y: target.rect.y - 3 },
          { x: target.rect.right + 3, y: target.rect.bottom + 3 },
          8,
        );
        await waitForNewAnnotation(5, before[5]);
        const after = await storageCounts();
        return {
          target,
          storageBefore: before,
          storageAfter: after,
          storage: after,
          events: await eventSummary(),
        };
      };
      const createTextMarkup = async (type) => {
        const before = await storageCounts();
        await clearProbe();
        await setMode(type);
        const target = await getTextDragPoints();
        const modeBefore = await viewer.evaluate(
          () => PDFViewerApplication.pdfViewer.annotationEditorMode,
        );
        await mouseMove(target.start, target.end, 12);
        await waitForNewAnnotation(type, before[type]);
        const summary = await eventSummary();
        const after = await storageCounts();
        return {
          type,
          modeBefore,
          modeAfter: summary.mode,
          target,
          storageBefore: before,
          storageAfter: after,
          eventSummary: summary,
        };
      };
      const assertTextSelectionWasPrioritized = (result, type) => {
        const pointerdown = result.eventSummary.events.find(
          (event) => event.type === "pointerdown",
        );
        assert.ok(
          pointerdown,
          `${typeNames.get(type)} must receive a real pointerdown`,
        );
        assert.equal(
          pointerdown.targetInTextLayer,
          true,
          `${typeNames.get(type)} should route old-markup drags to the text layer; hit was ${JSON.stringify(pointerdown)}`,
        );
        assert.equal(
          pointerdown.targetInEditorLayer,
          false,
          `${typeNames.get(type)} must not select the existing editor body during creation`,
        );
        const observedSelection = [
          result.eventSummary.selection,
          ...result.eventSummary.events
            .filter((event) => event.type === "selectionchange")
            .map((event) => event.text),
        ].join("\n");
        assert.match(
          observedSelection,
          /Dynamic languages/,
          `${typeNames.get(type)} should produce a native text selection`,
        );
        assert.equal(
          result.modeAfter,
          type,
          `${typeNames.get(type)} creation must leave the requested tool active`,
        );
        assert.equal(
          result.storageAfter[type],
          result.storageBefore[type] + 1,
          `${typeNames.get(type)} should add exactly one annotation`,
        );
      };
      const assertDrawingWasPrioritized = (result, type) => {
        const pointerdown = result.events.events.find(
          (event) => event.type === "pointerdown",
        );
        assert.ok(
          pointerdown,
          `${typeNames.get(type)} must receive pointerdown`,
        );
        assert.equal(
          pointerdown.targetInEditorLayer,
          true,
          `${typeNames.get(type)} should start drawing on the annotation layer, not the old editor body: ${JSON.stringify(pointerdown)}`,
        );
        assert.equal(
          result.events.mode,
          type,
          `${typeNames.get(type)} drawing must leave the creation tool active`,
        );
        assert.equal(
          result.storageAfter[type],
          result.storageBefore[type] + 1,
          `${typeNames.get(type)} should add exactly one annotation`,
        );
      };

      // Context-menu input must remain a context menu even over existing
      // annotations. Repeated right-clicks also exercise the delayed native
      // text-selection callback that can otherwise look like a second
      // left-button selection after pointerup.
      const rightDrag = await phraseGeometry();
      const initialSquares = (await storageCounts())[5];
      const rightDragSquare = await createSquareAroundText(
        "Dynamic languages such as JavaScript",
      );
      assertDrawingWasPrioritized(rightDragSquare, 5);
      const beforeRightDrag = await storageCounts();
      const currentMode = async () =>
        viewer.evaluate(
          () => PDFViewerApplication.pdfViewer.annotationEditorMode,
        );
      const undoModifier = process.platform === "darwin" ? "Meta" : "Control";
      const pressUndo = async () => {
        await page.keyboard.down(undoModifier);
        await page.keyboard.press("z");
        await page.keyboard.up(undoModifier);
      };
      const pressRedo = async () => {
        if (process.platform === "darwin") {
          await page.keyboard.down("Meta");
          await page.keyboard.down("Shift");
          await page.keyboard.press("z");
          await page.keyboard.up("Shift");
          await page.keyboard.up("Meta");
        } else {
          await page.keyboard.down("Control");
          await page.keyboard.press("y");
          await page.keyboard.up("Control");
        }
      };
      const rightClick = (point) =>
        page.mouse.click(
          iframeBox.x + point.x,
          iframeBox.y + point.y,
          { button: "right" },
        );
      await viewer.evaluate(() => {
        window.__rightMenus = [];
        document.addEventListener("contextmenu", (event) =>
          window.__rightMenus.push({ prevented: event.defaultPrevented }),
        );
      });
      await setMode(10);
      await rightClick(rightDrag.start);
      assert.equal(await currentMode(), 10, "Right-click must not change tools");
      assert.deepEqual(
        await storageCounts(),
        beforeRightDrag,
        "Right-click must not erase or create an annotation",
      );
      assert.ok(
        await viewer.evaluate(() =>
          window.__rightMenus.some((event) => !event.prevented),
        ),
        "Ordinary contextmenu stays available",
      );
      await page.keyboard.press("Escape");

      for (let attempt = 0; attempt < 10; attempt++) {
        await rightClick(rightDrag.start);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(
          await storageCounts(),
          beforeRightDrag,
          `Right-click ${attempt + 1} must not create delayed annotations`,
        );
        assert.equal(await currentMode(), 10);
        await page.keyboard.press("Escape");
      }

      // Reproduce platform default-action timing deterministically: some
      // browsers update text selection in a task after contextmenu dispatch.
      await viewer.evaluate(() => {
        document.addEventListener(
          "contextmenu",
          () => {
            setTimeout(() => {
              const text = document.querySelector(
                ".page .textLayer span",
              )?.firstChild;
              if (!text) {
                throw new Error("Missing text for context selection probe");
              }
              const range = document.createRange();
              range.setStart(text, 0);
              range.setEnd(text, Math.min(6, text.length));
              const selection = document.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
            }, 0);
          },
          { once: true },
        );
      });
      await rightClick(rightDrag.start);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const contextSelection = await eventSummary();
      assert.ok(
        contextSelection.selection,
        "The delayed context-menu selection probe must run",
      );
      assert.deepEqual(
        await storageCounts(),
        beforeRightDrag,
        "Delayed context-menu selection must not create an underline",
      );
      await viewer.evaluate(() => document.getSelection()?.removeAllRanges());
      await page.keyboard.press("Escape");

      const rightDragStart = {
        x: iframeBox.x + rightDrag.start.x,
        y: iframeBox.y + rightDrag.start.y,
      };
      const rightDragEnd = {
        x: iframeBox.x + rightDrag.end.x,
        y: iframeBox.y + rightDrag.end.y,
      };
      for (const originalMode of [0, 3, 5, 9, 10, 15, 17]) {
        await setMode(originalMode);
        await page.mouse.move(rightDragStart.x, rightDragStart.y);
        await page.mouse.down({ button: "right" });
        await page.mouse.move(rightDragStart.x + 2, rightDragStart.y);
        assert.equal(
          await currentMode(),
          originalMode,
          "Tiny click jitter must not activate the temporary eraser",
        );
        await page.mouse.move(rightDragEnd.x, rightDragEnd.y, { steps: 10 });
        await viewer.waitForFunction(
          () => PDFViewerApplication.pdfViewer.annotationEditorMode === 17,
        );
        await page.mouse.up({ button: "right" });
        await viewer.waitForFunction(
          (mode) =>
            PDFViewerApplication.pdfViewer.annotationEditorMode === mode,
          { timeout: 8_000 },
          originalMode,
        );
        assert.equal(
          (await storageCounts())[5],
          initialSquares,
          "Right-drag erases the existing Square",
        );
        assert.equal(
          (await storageCounts())[9],
          beforeRightDrag[9],
          "Right-drag must not create a Highlight",
        );

        await pressUndo();
        await viewer.waitForFunction(
          (count) =>
            [
              ...(PDFViewerApplication.pdfDocument.annotationStorage.serializable.map?.values() ||
                []),
            ].filter((entry) => entry.annotationType === 5 && !entry.deleted)
              .length === count,
          { timeout: 8_000 },
          beforeRightDrag[5],
        );
        if (originalMode === 0) {
          await pressRedo();
          assert.equal(
            (await storageCounts())[5],
            initialSquares,
            "Redo reapplies erasure without changing NONE",
          );
          await pressUndo();
          assert.equal((await storageCounts())[5], beforeRightDrag[5]);
        }
      }

      await setMode(10);
      await page.mouse.move(rightDragStart.x, rightDragStart.y);
      await page.mouse.down({ button: "right" });
      await page.mouse.move(rightDragEnd.x, rightDragEnd.y, { steps: 10 });
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 17,
      );
      await viewer.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.mouse.up({ button: "right" });
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 10,
      );
      await pressUndo();
      assert.equal(
        (await storageCounts())[5],
        beforeRightDrag[5],
        "Undo restores the Square after an interrupted right-drag",
      );
      const menuCount = await viewer.evaluate(() => window.__rightMenus.length);
      await rightClick(rightDrag.start);
      assert.ok(
        await viewer.evaluate(
          (count) => window.__rightMenus.length > count,
          menuCount,
        ),
        "A new right-click after a drag must still dispatch contextmenu",
      );
      await page.keyboard.press("Escape");
      results.push({
        scenario:
          "right-click contextmenu, delayed selection, 10 repeated clicks, right-drag eraser, Mac undo/redo, and all tool modes",
        passed: true,
        delayedSelection: contextSelection.selection,
      });
      await persistProgress();
      await reopenFixture();

      // Create a true mouse-drawn Square, then save/reopen it. The following
      // tests begin inside this persisted body instead of manufacturing a DOM
      // Selection, so they exercise Chrome hit-testing and PDF.js event routing.
      const baseSquare = await createSquareAroundText(
        "Dynamic languages such as JavaScript",
      );
      const baseSquareSave = await saveAndReopen();
      await setMode(5);
      await viewer.waitForFunction(
        () =>
          document.querySelectorAll(
            '.page[data-page-number="1"] .annotationEditorLayer .inkEditor',
          ).length >= 1,
        { timeout: 8_000 },
      );
      const squareEditorsAfterReopen = await squareEditors();
      results.push({
        scenario: "square-base-save-reopen",
        baseSquare,
        save: baseSquareSave,
        squareEditorsAfterReopen,
      });
      await persistProgress();
      assert.ok(
        squareEditorsAfterReopen.length >= 1,
        "The saved Square must be restored as an editable layer object",
      );

      // Core regression: the underline tool must still route real pointer
      // drags through a saved Square to the text layer, and the newly created
      // annotation must survive the host save/reopen bridge.
      const underlineOnSquare = await createTextMarkup(10);
      results.push({
        scenario: "underline-over-saved-square",
        underlineOnSquare,
      });
      await persistProgress();
      assertTextSelectionWasPrioritized(underlineOnSquare, 10);
      const underlineSave = await saveAndReopen();
      const sidecarAfterUnderlineSave = await sidecarSubtypeCounts();
      results.at(-1).save = underlineSave;
      results.at(-1).sidecarAfterSave = sidecarAfterUnderlineSave;
      await persistProgress();
      assert.ok(
        sidecarAfterUnderlineSave.Underline >= 1,
        "A mouse-created Underline over old markup must survive save/reopen",
      );
      const underlineOverUnderline = await createTextMarkup(10);
      results.at(-1).underlineOverSavedUnderline = underlineOverUnderline;
      await persistProgress();
      assertTextSelectionWasPrioritized(underlineOverUnderline, 10);

      // Starting inside an old Square in Square mode must create a second
      // Square, not select/move the old editor. Save it as the reusable
      // two-Square fixture for the remaining branches.
      await setMode(5);
      const squareBefore = await storageCounts();
      const oldSquare = (await squareEditors())[0];
      const squareStart = {
        x: oldSquare.rect.x + oldSquare.rect.width * 0.35,
        y: oldSquare.rect.y + oldSquare.rect.height / 2,
      };
      const squareEnd = {
        x: oldSquare.rect.x + oldSquare.rect.width * 0.7,
        y: oldSquare.rect.y + oldSquare.rect.height / 2 + 7,
      };
      await clearProbe();
      await mouseMove(squareStart, squareEnd, 8);
      await waitForNewAnnotation(5, squareBefore[5]);
      const squareOnSquare = {
        storageBefore: squareBefore,
        storageAfter: await storageCounts(),
        events: await eventSummary(),
      };
      results.push({
        scenario: "square-inside-saved-square",
        oldSquare,
        squareOnSquare,
      });
      await persistProgress();
      assertDrawingWasPrioritized(squareOnSquare, 5);
      const twoSquareSave = await saveAndReopen();
      await setMode(5);
      await viewer.waitForFunction(
        () =>
          document.querySelectorAll(
            '.page[data-page-number="1"] .annotationEditorLayer .inkEditor',
          ).length >= 2,
        { timeout: 8_000 },
      );
      const squaresAfterSave = await squareEditors();
      const sidecarAfterSquareSave = await sidecarSubtypeCounts();
      results.at(-1).save = twoSquareSave;
      results.at(-1).squaresAfterSave = squaresAfterSave;
      results.at(-1).sidecarAfterSave = sidecarAfterSquareSave;
      await persistProgress();
      assert.ok(
        squaresAfterSave.length >= 2 && sidecarAfterSquareSave.Square >= 2,
        `Both mouse-created Squares must survive save/reopen; editors=${squaresAfterSave.length}, sidecar=${sidecarAfterSquareSave.Square}`,
      );

      // Ink starts in the restored Square body. The page editor layer should
      // receive the actual pointer and create a new stroke.
      await setMode(15);
      const inkBefore = await storageCounts();
      const inkStartSquare = (await squareEditors())[0];
      await clearProbe();
      await mouseInkStroke(inkStartSquare.rect);
      const inkGestureEvents = await eventSummary();
      assert.ok(
        inkGestureEvents.events.some(
          (event) =>
            event.type === "pointermove" &&
            event.layerClass.includes("drawing"),
        ),
        "Ink should enter the drawing session while the mouse is held",
      );
      assert.equal(inkGestureEvents.mode, 15);
      // Ink intentionally supports multiple strokes in one session: mouseup
      // ends a stroke, while Escape commits the drawing as one editor.
      await page.keyboard.press("Escape");
      try {
        await waitForNewAnnotation(15, inkBefore[15]);
      } catch (error) {
        const failure = {
          scenario: "ink-inside-saved-square-commit-timeout",
          square: inkStartSquare,
          storageBefore: inkBefore,
          storageAfter: await storageCounts(),
          events: inkGestureEvents,
          afterEscape: await viewer.evaluate(() => ({
            mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
            layerClass: document.querySelector(
              '.page[data-page-number="1"] .annotationEditorLayer',
            )?.className,
            activeElement: {
              tag: document.activeElement?.tagName,
              className: document.activeElement?.className,
            },
            rawValues: [
              ...(PDFViewerApplication.pdfDocument.annotationStorage.serializable.map?.values() ||
                []),
            ].map((entry) => ({
              annotationType: entry.annotationType,
              deleted: entry.deleted,
              rect: entry.rect,
            })),
          })),
        };
        results.push(failure);
        await persistProgress();
        throw new Error(
          `${error.message}; evidence: ${JSON.stringify(failure)}`,
        );
      }
      const inkInSquare = {
        storageBefore: inkBefore,
        storageAfter: await storageCounts(),
        events: inkGestureEvents,
        modeAfterCommit: (await eventSummary()).mode,
      };
      results.push({ scenario: "ink-inside-saved-square", inkInSquare });
      await persistProgress();
      assertDrawingWasPrioritized(inkInSquare, 15);

      // Discard that branch and use the saved two-Square document to create a
      // FreeText box over old markup with the real mouse.
      await reopenSavedData();
      await setMode(3);
      const freeTextBefore = await storageCounts();
      const freeTextSquare = (await squareEditors())[0];
      await clearProbe();
      const freeTextCreationEventStart = await viewer.evaluate(
        () => window.__interactionEvents.length,
      );
      await page.mouse.click(
        iframeBox.x + freeTextSquare.rect.x + freeTextSquare.rect.width / 2,
        iframeBox.y + freeTextSquare.rect.y + freeTextSquare.rect.height / 2,
        { button: "left" },
      );
      const freeTextReadySelector =
        '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal';
      const waitForStableFreeTextReady = async (
        selector,
        afterEventIndex,
        { timeout = 15_000, expectedId = null, clickPoint = null } = {},
      ) =>
        viewer.waitForFunction(
          async ({ selector, afterEventIndex, expectedId, clickPoint }) => {
            const nextFrame = () =>
              new Promise((resolve) => requestAnimationFrame(resolve));
            const read = () => {
              const page = document.querySelector(
                '.page[data-page-number="1"]',
              );
              const internal = document.querySelector(selector);
              const editor = internal?.closest(
                ".freeTextEditor.selectedEditor",
              );
              const events = window.__interactionEvents.slice(afterEventIndex);
              const pointerdown = events.find(
                (event) =>
                  event.type === "pointerdown" &&
                  event.trusted &&
                  event.targetInEditorLayer &&
                  event.mode === 3,
              );
              const pointerup = pointerdown
                ? events.find(
                    (event) =>
                      event.type === "pointerup" &&
                      event.trusted &&
                      event.pointerId === pointerdown.pointerId &&
                      event.time >= pointerdown.time,
                  )
                : null;
              const focusEvents = events.filter(
                (event) =>
                  event.type === "focusin" || event.type === "focusout",
              );
              const rectOf = (element) => {
                const rect = element?.getBoundingClientRect();
                return rect
                  ? {
                      x: rect.x,
                      y: rect.y,
                      width: rect.width,
                      height: rect.height,
                    }
                  : null;
              };
              const click = clickPoint
                ? [...events]
                    .reverse()
                    .find(
                      (event) =>
                        event.type === "click" &&
                        Math.abs(
                          (event.point?.x ?? Infinity) - clickPoint.x,
                        ) <= 1 &&
                        Math.abs(
                          (event.point?.y ?? Infinity) - clickPoint.y,
                        ) <= 1,
                    )
                : null;
              return {
                pageReady:
                  page?.dataset.loaded === "true" &&
                  !page.classList.contains("loading") &&
                  !page.classList.contains("loadingIcon") &&
                  PDFViewerApplication.pdfViewer.annotationEditorMode === 3,
                internal,
                parent: internal?.parentElement,
                editor,
                editorParent: editor?.parentElement,
                activeElement: document.activeElement,
                internalRect: rectOf(internal),
                editorRect: rectOf(editor),
                pointerdown,
                pointerup,
                focusSignature: focusEvents
                  .map((event) =>
                    [
                      event.time,
                      event.type,
                      event.target?.id,
                      event.target?.className,
                      event.relatedTarget?.id,
                    ].join(":"),
                  )
                  .join("|"),
                click:
                  click &&
                  click.trusted &&
                  click.targetInSelectedFreeTextEditor &&
                  click.hitInSelectedFreeTextEditor
                    ? click
                    : null,
              };
            };
            const usable = (sample) =>
              sample.pageReady &&
              sample.internal?.isConnected &&
              sample.internal.getAttribute("contenteditable") === "true" &&
              sample.editor?.isConnected &&
              sample.internal.closest(".freeTextEditor.selectedEditor") ===
                sample.editor &&
              (!expectedId || sample.internal.id === expectedId) &&
              sample.internalRect?.width > 0 &&
              sample.internalRect?.height > 0 &&
              sample.editorRect?.width > 0 &&
              sample.editorRect?.height > 0 &&
              sample.pointerdown &&
              sample.pointerup &&
              (!clickPoint || sample.click);
            const sameRect = (left, right) =>
              left &&
              right &&
              ["x", "y", "width", "height"].every(
                (key) => Math.abs(left[key] - right[key]) <= 0.25,
              );
            const first = read();
            if (!usable(first)) return false;
            await nextFrame();
            const second = read();
            if (!usable(second)) return false;
            await nextFrame();
            const third = read();
            return (
              usable(third) &&
              first.internal === second.internal &&
              second.internal === third.internal &&
              first.parent === second.parent &&
              second.parent === third.parent &&
              first.editor === second.editor &&
              second.editor === third.editor &&
              first.editorParent === second.editorParent &&
              second.editorParent === third.editorParent &&
              first.activeElement === second.activeElement &&
              second.activeElement === third.activeElement &&
              first.focusSignature === second.focusSignature &&
              second.focusSignature === third.focusSignature &&
              sameRect(first.internalRect, second.internalRect) &&
              sameRect(second.internalRect, third.internalRect) &&
              sameRect(first.editorRect, second.editorRect) &&
              sameRect(second.editorRect, third.editorRect)
            );
          },
          { timeout },
          { selector, afterEventIndex, expectedId, clickPoint },
        );
      await waitForStableFreeTextReady(
        freeTextReadySelector,
        freeTextCreationEventStart,
      );
      const freeTextBeforeFocusClick = await viewer.evaluate(
        (selector, afterEventIndex) => {
          const internal = document.querySelector(selector);
          const rect = internal?.getBoundingClientRect();
          const editor = internal?.closest(
            ".freeTextEditor.selectedEditor",
          );
          const editorRect = editor?.getBoundingClientRect();
          return {
            time: performance.now(),
            id: internal?.id || null,
            contentEditable: internal?.getAttribute("contenteditable"),
            active: document.activeElement === internal,
            connected: Boolean(internal?.isConnected),
            selected: Boolean(
              internal?.closest(".freeTextEditor.selectedEditor"),
            ),
            rect: rect
              ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
              : null,
            editorRect: editorRect
              ? {
                  x: editorRect.x,
                  y: editorRect.y,
                  width: editorRect.width,
                  height: editorRect.height,
                }
              : null,
            activeElement: internal?.ownerDocument
              ? {
                  tag: document.activeElement?.tagName || null,
                  id: document.activeElement?.id || null,
                  className:
                    typeof document.activeElement?.className === "string"
                      ? document.activeElement.className
                      : "",
                }
              : null,
            loaded:
              document.querySelector('.page[data-page-number="1"]')?.dataset
                .loaded === "true",
            parent: internal?.parentElement
              ? {
                  tag: internal.parentElement.tagName,
                  className:
                    typeof internal.parentElement.className === "string"
                      ? internal.parentElement.className
                      : "",
                }
              : null,
            pointerdown: window.__interactionEvents
              .slice(afterEventIndex)
              .find(
                (event) =>
                  event.type === "pointerdown" &&
                  event.trusted &&
                  event.targetInEditorLayer &&
                  event.mode === 3,
              ),
            pointerup: window.__interactionEvents
              .slice(afterEventIndex)
              .find((event) => event.type === "pointerup" && event.trusted),
            recentFocusEvents: window.__interactionEvents
              .filter(
                (event) =>
                  event.type === "focusin" || event.type === "focusout",
              )
              .slice(-8),
          };
        },
        freeTextReadySelector,
        freeTextCreationEventStart,
      );
      const freeTextFocusEvidence = {
        scenario: "freetext-focus-probe",
        beforeClick: freeTextBeforeFocusClick,
      };
      results.push(freeTextFocusEvidence);
      await persistProgress();
      assert.ok(
        freeTextBeforeFocusClick.editorRect?.width > 0 &&
          freeTextBeforeFocusClick.editorRect?.height > 0,
        "The selected FreeText outer editor must provide a real mouse hit target even when its empty internal has zero width",
      );
      const freeTextClickPoint = {
        x:
          freeTextBeforeFocusClick.editorRect.x +
          freeTextBeforeFocusClick.editorRect.width / 2,
        y:
          freeTextBeforeFocusClick.editorRect.y +
          freeTextBeforeFocusClick.editorRect.height / 2,
      };
      const freeTextHitBeforeClick = await viewer.evaluate(
        ({ selector, point }) => {
          const internal = document.querySelector(selector);
          const editor = internal?.closest(
            ".freeTextEditor.selectedEditor",
          );
          const hit = document.elementFromPoint(point.x, point.y);
          return {
            time: performance.now(),
            hit: hit
              ? {
                  tag: hit.tagName,
                  id: hit.id || "",
                  className:
                    typeof hit.className === "string" ? hit.className : "",
                }
              : null,
            insideInternal: Boolean(
              internal && hit && (hit === internal || internal.contains(hit)),
            ),
            insideEditor: Boolean(
              editor && hit && (hit === editor || editor.contains(hit)),
            ),
          };
        },
        { selector: freeTextReadySelector, point: freeTextClickPoint },
      );
      freeTextFocusEvidence.hitBeforeRefocus = freeTextHitBeforeClick;
      await persistProgress();
      const refocusWithMouse = !freeTextBeforeFocusClick.active;
      freeTextFocusEvidence.focusPath = refocusWithMouse
        ? "real-mouse-refocus"
        : "focused-by-real-creation-pointerdown";
      assert.equal(
        freeTextBeforeFocusClick.pointerdown?.trusted,
        true,
        "The FreeText editor must have been created by a trusted pointerdown",
      );
      if (refocusWithMouse) {
        assert.equal(
          freeTextHitBeforeClick.insideEditor,
          true,
          "A blurred FreeText editor can only be refocused by a real click that hits the selected editor",
        );
        const refocusEventStart = await viewer.evaluate(
          () => window.__interactionEvents.length,
        );
        await page.mouse.click(
          iframeBox.x + freeTextClickPoint.x,
          iframeBox.y + freeTextClickPoint.y,
          { button: "left" },
        );
        try {
          await waitForStableFreeTextReady(
            freeTextReadySelector,
            refocusEventStart,
            {
              timeout: 10_000,
              expectedId: freeTextBeforeFocusClick.id,
              clickPoint: freeTextClickPoint,
            },
          );
        } catch (error) {
          freeTextFocusEvidence.focusClickFailure = {
            time: await viewer.evaluate(() => performance.now()),
            message: error.message,
            eventTail: await viewer.evaluate(() =>
              window.__interactionEvents.slice(-40),
            ),
          };
          await persistProgress();
          throw error;
        }
      }
      const freeTextFocusBeforeTyping = await viewer.evaluate(
        ({ selector, point }) => {
          const internal = document.querySelector(selector);
          const editor = internal?.closest(
            ".freeTextEditor.selectedEditor",
          );
          const rect = internal?.getBoundingClientRect();
          const editorRect = editor?.getBoundingClientRect();
          const hit = editorRect
            ? document.elementFromPoint(
                editorRect.x + editorRect.width / 2,
                editorRect.y + editorRect.height / 2,
              )
            : null;
          const click = [...window.__interactionEvents]
            .reverse()
            .find(
              (event) =>
                event.type === "click" &&
                Math.abs((event.point?.x ?? Infinity) - point.x) <= 1 &&
                Math.abs((event.point?.y ?? Infinity) - point.y) <= 1,
            );
          return {
            time: performance.now(),
            id: internal?.id || null,
            contentEditable: internal?.getAttribute("contenteditable"),
            active: document.activeElement === internal,
            connected: Boolean(internal?.isConnected),
            selected: Boolean(
              internal?.closest(".freeTextEditor.selectedEditor"),
            ),
            internalRect: rect
              ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
              : null,
            editorRect: editorRect
              ? {
                  x: editorRect.x,
                  y: editorRect.y,
                  width: editorRect.width,
                  height: editorRect.height,
                }
              : null,
            actualElementFromPoint: hit
              ? {
                  tag: hit.tagName,
                  id: hit.id || "",
                  className:
                    typeof hit.className === "string" ? hit.className : "",
                }
              : null,
            actualElementFromPointInsideInternal: Boolean(
              internal && hit && (hit === internal || internal.contains(hit)),
            ),
            actualElementFromPointInsideEditor: Boolean(
              editor && hit && (hit === editor || editor.contains(hit)),
            ),
            realClick: click || null,
            recentFocusEvents: window.__interactionEvents
              .filter(
                (event) => event.type === "focusin" || event.type === "focusout",
              )
              .slice(-10),
          };
        },
        { selector: freeTextReadySelector, point: freeTextClickPoint },
      );
      freeTextFocusEvidence.afterClick = freeTextFocusBeforeTyping;
      await persistProgress();
      if (
        freeTextFocusBeforeTyping.contentEditable !== "true" ||
        !freeTextFocusBeforeTyping.active ||
        !freeTextFocusBeforeTyping.connected ||
        !freeTextFocusBeforeTyping.selected ||
        (refocusWithMouse &&
          !freeTextFocusBeforeTyping.actualElementFromPointInsideEditor)
      ) {
        results.push({
          scenario: "freetext-focus-after-real-click-failure",
          beforeClick: freeTextBeforeFocusClick,
          hitBeforeRefocus: freeTextHitBeforeClick,
          afterClick: freeTextFocusBeforeTyping,
          eventTail: await viewer.evaluate(() =>
            window.__interactionEvents.slice(-40),
          ),
        });
        await persistProgress();
      }
      assert.equal(freeTextFocusBeforeTyping.contentEditable, "true");
      assert.equal(freeTextFocusBeforeTyping.active, true);
      assert.equal(freeTextFocusBeforeTyping.connected, true);
      assert.equal(freeTextFocusBeforeTyping.selected, true);
      if (refocusWithMouse) {
        assert.equal(
          freeTextFocusBeforeTyping.actualElementFromPointInsideEditor,
          true,
        );
      }
      await page.keyboard.type("12345");
      await viewer.waitForFunction(
        (internalId) => {
          const internal = document.getElementById(internalId);
          const inputEvents = window.__interactionEvents.filter(
            (event) =>
              event.type === "input" && event.target?.id === internalId,
          );
          const keyEvents = window.__interactionEvents
            .filter(
              (event) =>
                event.type === "keydown" &&
                event.target?.id === internalId &&
                /^[1-5]$/.test(event.key || ""),
            );
          return (
            internal?.isConnected &&
            internal.closest(".freeTextEditor.selectedEditor") !== null &&
            document.activeElement === internal &&
            internal.textContent.includes("12345") &&
            inputEvents.length >= 5 &&
            inputEvents.every((event) => event.trusted) &&
            keyEvents.length === 5 &&
            keyEvents.map((event) => event.key).join("") === "12345" &&
            keyEvents.every((event) => event.trusted)
          );
        },
        { timeout: 15_000 },
        freeTextFocusBeforeTyping.id,
      );
      const freeTextBeforeCommit = await viewer.evaluate((internalId) => {
        const internal = document.getElementById(internalId);
        return {
          text: internal?.textContent || "",
          contentEditable: internal?.getAttribute("contenteditable"),
          active: document.activeElement === internal,
          connected: Boolean(internal?.isConnected),
          selected: Boolean(
            internal?.closest(".freeTextEditor.selectedEditor"),
          ),
          keyEvents: window.__interactionEvents
            .filter(
              (event) =>
                event.type === "keydown" &&
                event.target?.id === internalId &&
                /^[1-5]$/.test(event.key || ""),
            )
            .map((event) => ({ key: event.key, trusted: event.trusted })),
          inputEvents: window.__interactionEvents
            .filter(
              (event) =>
                event.type === "input" && event.target?.id === internalId,
            )
            .map((event) => ({ data: event.data, trusted: event.trusted })),
        };
      }, freeTextFocusBeforeTyping.id);
      assert.equal(freeTextBeforeCommit.contentEditable, "true");
      assert.equal(freeTextBeforeCommit.active, true);
      assert.equal(freeTextBeforeCommit.selected, true);
      assert.match(freeTextBeforeCommit.text, /12345/);
      assert.deepEqual(
        freeTextBeforeCommit.keyEvents.map((event) => event.key),
        ["1", "2", "3", "4", "5"],
      );
      assert.ok(freeTextBeforeCommit.keyEvents.every((event) => event.trusted));
      assert.ok(
        freeTextBeforeCommit.inputEvents.length >= 5 &&
          freeTextBeforeCommit.inputEvents.every((event) => event.trusted),
      );
      await page.keyboard.press("Escape");
      await waitForNewAnnotation(3, freeTextBefore[3]);
      const freeTextOnSquare = {
        storageBefore: freeTextBefore,
        storageAfter: await storageCounts(),
        events: await eventSummary(),
        input: freeTextBeforeCommit,
      };
      results.push({
        scenario: "freetext-over-saved-square",
        freeTextOnSquare,
      });
      await persistProgress();
      assert.equal(freeTextOnSquare.storageAfter[3], freeTextBefore[3] + 1);
      assert.equal(
        freeTextOnSquare.input.contentEditable,
        "true",
        "New FreeText must remain editable over existing markup",
      );
      assert.equal(freeTextOnSquare.events.mode, 3);
      const freeTextSave = await saveAndReopen();
      await viewer.waitForFunction(() => [...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(0)]
        .some(editor => (editor.constructor?._editorType === 3 || editor.editorType === "freetext") &&
          (editor.value || editor.div?.querySelector(".internal")?.textContent || "").includes("12345")),
      { timeout: 5_000 });
      const savedFreeText = await viewer.evaluate(async () => {
        const manager = PDFViewerApplication.pdfViewer._layerProperties
          .annotationEditorUIManager;
        const editors = [...manager.getEditors(0)]
          .filter((editor) =>
            editor.constructor?._editorType === 3 || editor.editorType === "freetext",
          )
          .map((editor) => {
            const rect = editor.div?.getBoundingClientRect();
            const internal = editor.div?.querySelector(".internal");
            const style = editor.div ? getComputedStyle(editor.div) : null;
            return {
              uuid: editor.id ?? editor.uid ?? null,
              value: editor.value ?? internal?.textContent ?? "",
              textContent: internal?.textContent ?? "",
              width: rect?.width ?? 0,
              height: rect?.height ?? 0,
              display: style?.display ?? null,
              visibility: style?.visibility ?? null,
              opacity: style?.opacity ?? null,
            };
          });
        const snapshot = parent.__browserSidecarHost.snapshotFor(
          "fixtures/tracemonkey.pdf",
        );
        const sidecarRows = snapshot?.annotations.filter(
          (operation) => operation.kind === "FreeText" &&
            operation.payload?.editor?.value?.includes("12345"),
        ) ?? [];
        return { editors, sidecarRows };
      });
      results.at(-1).save = freeTextSave;
      results.at(-1).savedFreeText = savedFreeText;
      await persistProgress();
      assert.ok(
        savedFreeText.sidecarRows.some((operation) =>
          operation.payload.editor.value.includes("12345"),
        ),
        "Entered FreeText '12345' must survive save/reopen",
      );
      assert.ok(
        savedFreeText.editors.some((editor) =>
          editor.textContent.includes("12345") && editor.width > 0 &&
          editor.height > 0 && editor.display !== "none" &&
          editor.visibility !== "hidden" && editor.opacity !== "0",
        ),
        `The reopened sidecar FreeText must have nonempty text, visible geometry, and positive area: ${JSON.stringify(savedFreeText)}`,
      );

      // Create a Highlight over the old markup, save/reopen it, and verify
      // that the next Highlight gesture selects text over its internal/SVG
      // bodies instead of entering object-selection mode.
      await reopenSavedData();
      const highlightOnMarkup = await createTextMarkup(9);
      results.push({
        scenario: "highlight-over-saved-markup-and-highlight",
        highlightOnMarkup,
      });
      await persistProgress();
      assertTextSelectionWasPrioritized(highlightOnMarkup, 9);
      const highlightSave = await saveAndReopen();
      results.at(-1).save = highlightSave;
      await persistProgress();
      const savedHighlight = await page.evaluate(() => {
        const saved = window.__hostState.savedOperations.at(-1);
        const snapshot = window.__browserSidecarHost.snapshotFor(saved?.documentId);
        const operation = [...(saved?.operations || [])].reverse()
          .find((row) => row.kind === "Highlight" && row.deleted !== true);
        const row = snapshot?.annotations.find((entry) => entry.uuid === operation?.uuid);
        const targetText = row?.payload?.editor?.text;
        const pageIndex = row?.pageIndex;
        return {
          uuid: row?.uuid ?? null,
          pageIndex: Number.isSafeInteger(pageIndex) ? pageIndex : null,
          pageIdentity: Number.isSafeInteger(pageIndex)
            ? snapshot?.source?.orderedPageIdentities?.[pageIndex] ?? null : null,
          sourceHash: snapshot?.source?.sourceHash ?? null,
          targetText: typeof targetText === "string" ? targetText : null,
        };
      });
      assert.ok(savedHighlight.uuid, "the real Highlight is present in the Sidecar snapshot after save/reopen");
      assert.ok(savedHighlight.targetText?.includes("Dynamic languages"), JSON.stringify(savedHighlight));
      assert.equal(typeof savedHighlight.pageIdentity, "string");
      assert.equal(await page.evaluate(() => window.__browserSidecarHost.identityRequests.at(-1)?.sourceHash),
        savedHighlight.sourceHash, 'The reopened fixture must carry the same source identity as the real Host');
      results.at(-1).savedHighlight = savedHighlight;
      await viewer.$eval("#pdfReaderAnnotationSidebarButton", (button) => button.click());
      await viewer.waitForFunction(() =>
        !document.getElementById("pdfReaderAnnotationSidebarMenu")?.classList.contains("hidden") &&
        document.getElementById("pdfReaderAnnotationSidebarSearch")?.isConnected &&
        document.getElementById("pdfReaderAnnotationSidebarTypeFilter")?.isConnected,
      { timeout: 10_000 });
      results.at(-1).sidebarBeforeSearch = await viewer.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        return { count: document.getElementById('editorCommentsSidebarCount')?.textContent,
          rows: [...document.querySelectorAll('#editorCommentsSidebarList li.sidebarComment')]
            .map(row => ({uuid:row.dataset.uuid,text:row.querySelector('.sidebarCommentText')?.textContent})) };
      });
      const normalizedTargetText = savedHighlight.targetText.replace(/\s+/gu, " ").trim();
      const searchTerm = normalizedTargetText.slice(0, Math.min(24, normalizedTargetText.length));
      await viewer.type("#pdfReaderAnnotationSidebarSearch", searchTerm);
      await viewer.select("#pdfReaderAnnotationSidebarTypeFilter", "Highlight");
      results.at(-1).sidebarAfterSearch = await viewer.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        return { count:document.getElementById('editorCommentsSidebarCount')?.textContent,
          term:document.getElementById('pdfReaderAnnotationSidebarSearch')?.value,
          kind:document.getElementById('pdfReaderAnnotationSidebarTypeFilter')?.value,
          rows:[...document.querySelectorAll('#editorCommentsSidebarList li.sidebarComment')]
            .map(row=>({uuid:row.dataset.uuid,text:row.querySelector('.sidebarCommentText')?.textContent})) };
      });
      await persistProgress();
      await viewer.waitForFunction(({ uuid, targetText }) => {
        const rows = [...document.querySelectorAll("#editorCommentsSidebarList li.sidebarComment")];
        return document.getElementById("editorCommentsSidebarCount")?.textContent === "1" &&
          rows.length === 1 && rows[0].dataset.uuid === uuid &&
          rows[0].querySelector(".sidebarCommentText")?.textContent === targetText.replace(/\s+/gu, " ").trim();
      }, { timeout: 10_000 }, savedHighlight);
      await viewer.evaluate(() => {
        window.__drawingFixtureScrollTrace = [];
        const container = document.getElementById('viewerContainer');
        const capture = event => {
          window.__drawingFixtureScrollTrace.push({type:event.type,time:performance.now(),top:container.scrollTop,left:container.scrollLeft});
          if (window.__drawingFixtureScrollTrace.length > 40) window.__drawingFixtureScrollTrace.shift();
        };
        container.addEventListener('scroll', capture);
        container.addEventListener('scrollend', capture);
      });
      await viewer.$eval(
        `#editorCommentsSidebarList li.sidebarComment[data-uuid="${savedHighlight.uuid}"] .pdfReaderAnnotationSidebarNavigate`,
        (button) => button.click(),
      );
      await viewer.waitForFunction(({ uuid, pageIndex }) => {
        const row = document.querySelector(`#editorCommentsSidebarList li.sidebarComment[data-uuid="${uuid}"]`);
        return PDFViewerApplication.pdfViewer.currentPageNumber === pageIndex + 1 &&
          row?.classList.contains("selected");
      }, { timeout: 15_000 }, savedHighlight);
      const reviewButton = `#editorCommentsSidebarList li.sidebarComment[data-uuid="${savedHighlight.uuid}"] .pdfReaderAnnotationReviewButton`;
      assert.equal(await viewer.$eval(reviewButton, (button) => button.disabled), false,
        "the persisted Highlight text enables the explicit review request");
      const reviewRequestCount = await page.evaluate(() => window.__hostState.reviewDraftRequests.length);
      const pageBeforeReviewRequest = await viewer.evaluate(() => PDFViewerApplication.pdfViewer.currentPageNumber);
      await viewer.$eval(reviewButton, (button) => button.click());
      await page.waitForFunction((count) =>
        window.__hostState.reviewDraftRequests.length === count + 1,
      { timeout: 10_000 }, reviewRequestCount);
      const reviewRequest = await page.evaluate(() => window.__hostState.reviewDraftRequests.at(-1));
      const openedSession = await page.evaluate(() => window.__hostState.openedMessages.at(-1));
      assert.equal(reviewRequest.documentId, "fixtures/tracemonkey.pdf");
      assert.equal(reviewRequest.openRequest, openedSession.openRequest);
      assert.equal(reviewRequest.sourceHash, savedHighlight.sourceHash);
      assert.equal(reviewRequest.pageIndex, savedHighlight.pageIndex);
      assert.equal(reviewRequest.pageIdentity, savedHighlight.pageIdentity);
      assert.equal(reviewRequest.uuid, savedHighlight.uuid);
      assert.equal(reviewRequest.targetText, savedHighlight.targetText);
      assert.ok(["captured", "stored"].includes(reviewRequest.targetTextSource));
      assert.equal(reviewRequest.revision, openedSession.revision);
      assert.equal(reviewRequest.confirmedRevision, openedSession.confirmedRevision);
      assert.equal(reviewRequest.revision, reviewRequest.confirmedRevision);
      assert.equal(reviewRequest.dirty, false);
      assert.equal(reviewRequest.pending, false);
      assert.equal(typeof reviewRequest.rendererGeneration, "string");
      assert.equal(await viewer.evaluate(() => PDFViewerApplication.pdfViewer.currentPageNumber), pageBeforeReviewRequest,
        "the sibling review button posts a request without triggering annotation navigation");
      results.at(-1).semanticSidebar = { savedHighlight, reviewRequest };
      await persistProgress();
      await viewer.$eval("#editorCommentsSidebarCloseButton", (button) => button.click());
      // The preceding exact navigation intentionally starts a smooth scroll.
      // Restore this drawing fixture's viewport before deriving pointer points;
      // otherwise the page moves between the geometry read and trusted drag.
      // Sidebar selection confirms navigation was issued, not that native
      // scrolling finished. Do not compete with its final asynchronous tick.
      await viewer.waitForFunction(async () => {
        const container = document.getElementById('viewerContainer');
        const viewer = PDFViewerApplication.pdfViewer;
        const trace = window.__drawingFixtureScrollTrace;
        const lastEvent = trace?.at(-1);
        if (lastEvent?.type !== 'scrollend' || viewer.getPageView(0)?.renderingState !== 3) return false;
        const bounds = viewer.getPageView(0).div.getBoundingClientRect();
        const position = {top:container.scrollTop,left:container.scrollLeft,x:bounds.x,y:bounds.y};
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const after = viewer.getPageView(0).div.getBoundingClientRect();
        const stable = trace.at(-1) === lastEvent && container.scrollTop === position.top &&
          container.scrollLeft === position.left && after.x === position.x && after.y === position.y;
        if (stable) window.__drawingFixtureSettled = {position,scrollEnd:lastEvent};
        return stable;
      }, {timeout:5_000});
      results.at(-1).drawingViewportReset = await viewer.evaluate(async () => {
        const container=document.getElementById('viewerContainer');
        const before={top:container.scrollTop,left:container.scrollLeft};
        container.scrollTo({top:0,left:0,behavior:'instant'});
        const immediate={top:container.scrollTop,left:container.scrollLeft};
        await new Promise(requestAnimationFrame);
        return {settled:window.__drawingFixtureSettled,before,immediate,afterFrame:{top:container.scrollTop,left:container.scrollLeft},
          activeElement:document.activeElement?.outerHTML?.slice(0,300),
          pageNumber:PDFViewerApplication.pdfViewer.currentPageNumber,
          pageBounds:PDFViewerApplication.pdfViewer.getPageView(0)?.div?.getBoundingClientRect()?.toJSON(),
          renderingState:PDFViewerApplication.pdfViewer.getPageView(0)?.renderingState,
          mode:PDFViewerApplication.pdfViewer.annotationEditorMode,
          managerMode:PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getMode(),
          scrollTrace:window.__drawingFixtureScrollTrace};
      });
      await persistProgress();
      assert.equal(results.at(-1).drawingViewportReset.afterFrame.top, 0,
        'Drawing fixture viewport was not restored');
      const highlightOverHighlight = await createTextMarkup(9);
      results.at(-1).highlightOverHighlight = highlightOverHighlight;
      await persistProgress();
      assertTextSelectionWasPrioritized(highlightOverHighlight, 9);

      // Add an unmarked Square near the title so the NONE/double-click test
      // does not accidentally hit the several intentional markups over the
      // Abstract phrase used by the other scenarios.
      const titleSquare = await createSquareAroundText(
        "Trace-based Just-in-Time",
      );
      results.push({
        scenario: "separate-square-for-explicit-edit",
        titleSquare,
      });
      await persistProgress();
      assertDrawingWasPrioritized(titleSquare, 5);
      const titleSquareSave = await saveAndReopen();
      results.at(-1).save = titleSquareSave;
      await persistProgress();

      // Capture saved objects while mode 5 has reconstructed their editors;
      // NONE may tear down those DOM roots, so never read the target from the
      // disabled layer after switching modes.
      await setMode(5);
      await viewer.waitForFunction(
        () => {
          const storage = PDFViewerApplication.pdfDocument.annotationStorage;
          return (
            [
              ...document.querySelectorAll(
                '.page[data-page-number="1"] .annotationEditorLayer .inkEditor',
              ),
            ].filter(
              (element) =>
                storage.getRawValue(element.id)?.constructor?._editorType === 5,
            ).length >= 3
          );
        },
        { timeout: 8_000 },
      );
      const squaresBeforeEdit = await squareEditors();
      assert.ok(squaresBeforeEdit.length >= 3);
      const titleGeometry = await phraseGeometry("Trace-based Just-in-Time");
      const titleCenter = {
        x: titleGeometry.rect.x + titleGeometry.rect.width / 2,
        y: titleGeometry.rect.y + titleGeometry.rect.height / 2,
      };
      const firstSquare = [...squaresBeforeEdit].sort((left, right) => {
        const distance = (square) =>
          Math.hypot(
            square.rect.x + square.rect.width / 2 - titleCenter.x,
            square.rect.y + square.rect.height / 2 - titleCenter.y,
          );
        return distance(left) - distance(right);
      })[0];
      const secondSquareBeforeEdit = squaresBeforeEdit.find(
        (editor) => editor.id !== firstSquare.id,
      );
      await setMode(0);
      await waitForSquareHitReady(firstSquare);
      await clearProbe();
      await page.mouse.click(
        iframeBox.x + firstSquare.rect.x + firstSquare.rect.width / 2,
        iframeBox.y + firstSquare.rect.y + firstSquare.rect.height / 2,
        { button: "left" },
      );
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 5,
        { timeout: 8_000 },
      );
      const firstClickSelection = await viewer.evaluate((editorId) => {
        const selected = document.getElementById(editorId);
        const raw = PDFViewerApplication.pdfDocument.annotationStorage.getRawValue(editorId);
        return {
          id: selected?.id || null,
          className: selected?.className || null,
          editorType: raw?.constructor?._editorType ?? raw?._editorType ?? null,
          selected: selected?.classList.contains("selectedEditor") || false,
          mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
        };
      }, firstSquare.id);
      assert.equal(firstClickSelection.id, firstSquare.id,
        "A real NONE-mode click must hit the intended sidecar Square editor");
      assert.equal(firstClickSelection.editorType, 5,
        "The hit editor must still identify as a Square after entering its tool mode");
      assert.equal(firstClickSelection.selected, true,
        "The clicked sidecar Square must become the selected editor");
      const clickEvents = await eventSummary();
      const firstPointerDown = clickEvents.events.find(
        (event) => event.type === "pointerdown",
      );
      assert.equal(firstPointerDown?.target?.id, firstSquare.id,
        "The trusted pointerdown must target the intended sidecar editor, not a native PDF annotation node");
      assert.equal(firstPointerDown?.targetInEditorLayer, true);

      // Selection must leave this durable object reachable by the next real
      // pointer gesture. A test-only editId dispatch must not conceal a broken
      // NONE -> selected Square transition behind creation-priority CSS.
      const squareBeforeNativeMove = await viewer.evaluate((id) => {
        const node = document.getElementById(id), rect = node.getBoundingClientRect();
        const editor = PDFViewerApplication.pdfDocument.annotationStorage.getRawValue(id);
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { rect: editor.serialize(true).rect, hitSameEditor: hit === node || node.contains(hit),
          point: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } };
      }, firstSquare.id);
      assert.equal(squareBeforeNativeMove.hitSameEditor, true,
        "A genuinely selected Square must remain pointer-hittable without a test-only editId override");
      await page.mouse.move(iframeBox.x + squareBeforeNativeMove.point.x, iframeBox.y + squareBeforeNativeMove.point.y);
      await page.mouse.down();
      await page.mouse.move(iframeBox.x + squareBeforeNativeMove.point.x + 20,
        iframeBox.y + squareBeforeNativeMove.point.y + 14, { steps: 12 });
      await page.mouse.up();
      await viewer.waitForFunction(({ id, before }) => {
        const editor = PDFViewerApplication.pdfDocument.annotationStorage.getRawValue(id);
        return editor && JSON.stringify(editor.serialize(true).rect) !== JSON.stringify(before);
      }, { timeout: 8_000 }, { id: firstSquare.id, before: squareBeforeNativeMove.rect });
      const squaresAfterNativeMove = await squareEditors();
      assert.equal(squaresAfterNativeMove.length, squaresBeforeEdit.length,
        "Moving a selected durable Square must not create another annotation");
      const movedSquare = squaresAfterNativeMove.find(editor => editor.id === firstSquare.id);
      assert.equal(movedSquare?.uid, firstSquare.uid, "Native movement retains the exact selected editor identity");
      firstSquare.rect = movedSquare.rect;

      // A click in NONE selects the durable sidecar editor and activates its
      // matching tool. Use PDF.js's explicit editId route to test the toolbar
      // state independently of the obsolete PDF-annotation double-click path.
      await viewer.evaluate((editId) => {
        PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
          mode: 5,
          editId,
          mustEnterInEditMode: true,
        });
      }, firstSquare.uid);
      await viewer.waitForFunction((uid) => {
        const explicit = document.querySelector(
          '.page[data-page-number="1"] .annotationEditorLayer .explicitlyEditing',
        );
        return explicit &&
          PDFViewerApplication.pdfDocument.annotationStorage.getRawValue(explicit.id)?.uid === uid;
      }, { timeout: 8_000 }, firstSquare.uid);
      const explicitFirst = await viewer.evaluate(() => {
        const layer = document.querySelector(
          '.page[data-page-number="1"] .annotationEditorLayer',
        );
        const selected = layer.querySelector(".explicitlyEditing");
        const rect = selected.getBoundingClientRect();
        return {
          id: selected.id,
          uid: PDFViewerApplication.pdfDocument.annotationStorage.getRawValue(
            selected.id,
          )?.uid,
          mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
          editorClass: selected.className,
          explicitCount: layer.querySelectorAll(".explicitlyEditing").length,
          selectedCount: layer.querySelectorAll(".selectedEditor").length,
          rect: {
            x: rect.x,
            y: rect.y,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          },
          toolbar: Boolean(selected.querySelector(".editToolbar")),
        };
      });
      assert.equal(explicitFirst.mode, 5);
      assert.equal(explicitFirst.explicitCount, 1);
      assert.equal(explicitFirst.toolbar, true);

      const moveStart = {
        x: explicitFirst.rect.x + explicitFirst.rect.width * 0.45,
        y: explicitFirst.rect.y + explicitFirst.rect.height / 2,
      };
      const moveEnd = { x: moveStart.x + 28, y: moveStart.y + 24 };
      await clearProbe();
      await mouseMove(moveStart, moveEnd, 8);
      await viewer.waitForFunction(
        ({ id, x, y }) => {
          const rect = document.getElementById(id)?.getBoundingClientRect();
          return rect && Math.abs(rect.x - x) > 5 && Math.abs(rect.y - y) > 5;
        },
        { timeout: 8_000 },
        {
          id: explicitFirst.id,
          x: explicitFirst.rect.x,
          y: explicitFirst.rect.y,
        },
      );
      const movedFirst = await viewer.evaluate((id) => {
        const rect = document.getElementById(id).getBoundingClientRect();
        const layer = document.querySelector(
          '.page[data-page-number="1"] .annotationEditorLayer',
        );
        return {
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          explicitCount: layer.querySelectorAll(".explicitlyEditing").length,
          toolbarHitTesting: getComputedStyle(
            document.getElementById(id).querySelector(".editToolbar"),
          ).pointerEvents,
        };
      }, explicitFirst.id);
      assert.ok(Math.abs(movedFirst.rect.x - explicitFirst.rect.x) > 5);
      assert.ok(Math.abs(movedFirst.rect.y - explicitFirst.rect.y) > 5);
      assert.equal(movedFirst.explicitCount, 1);
      assert.notEqual(movedFirst.toolbarHitTesting, "none");

      assert.ok(
        secondSquareBeforeEdit,
        "Expected a second same-type Square editor",
      );
      // Request a same-mode edit by the real editor UID. This covers the
      // explicit editId path independently of a second on-screen double-click
      // (which would be ambiguous for overlapping creation-mode hitboxes).
      await viewer.evaluate((editId) => {
        PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
          mode: 5,
          editId,
          mustEnterInEditMode: true,
        });
      }, secondSquareBeforeEdit.uid);
      await viewer.waitForFunction(
        (uid) => {
          const layer = document.querySelector(
            '.page[data-page-number="1"] .annotationEditorLayer',
          );
          const explicit = layer.querySelectorAll(".explicitlyEditing");
          if (explicit.length !== 1) return false;
          const storage = PDFViewerApplication.pdfDocument.annotationStorage;
          return storage.getRawValue(explicit[0].id)?.uid === uid;
        },
        { timeout: 8_000 },
        secondSquareBeforeEdit.uid,
      );
      const explicitSecond = await viewer.evaluate(() => {
        const layer = document.querySelector(
          '.page[data-page-number="1"] .annotationEditorLayer',
        );
        const storage = PDFViewerApplication.pdfDocument.annotationStorage;
        return {
          explicitCount: layer.querySelectorAll(".explicitlyEditing").length,
          explicitUids: [...layer.querySelectorAll(".explicitlyEditing")].map(
            (element) => storage.getRawValue(element.id)?.uid,
          ),
        };
      });
      assert.deepEqual(explicitSecond.explicitUids, [
        secondSquareBeforeEdit.uid,
      ]);
      results.push({
        scenario: "none-doubleclick-explicit-edit-and-move",
        explicitFirst,
        movedFirst,
        explicitSecond,
      });
      await persistProgress();

      await page.screenshot({
        path: path.join(artifacts, `annotation-interaction-${artifactId}.png`),
        fullPage: false,
      });
      const diagnostics = {
        fixture: "tests/fixtures/tracemonkey.pdf (read-only public fixture)",
        payloadId: payload.id,
        contentHash: payload.contentHash,
        browserPath,
        openTraceRunId,
        openTrace: await viewer.evaluate(() =>
          window.__pdfOpenTrace?.map((entry) => ({ ...entry })) ?? [],
        ),
        workerMessages: await viewer.evaluate(() =>
          window.__pdfWorkerMessages?.slice(-200) ?? [],
        ),
        workerLifecycles: await viewer.evaluate(() =>
          window.__pdfWorkerLifecycles?.slice(-200) ?? [],
        ),
        cdpWorkerTrace,
        lifecycleEvents: await viewer.evaluate(() =>
          window.__pdfLifecycleEvents?.slice(-20) ?? [],
        ),
        scenarios: results,
        apiRequestCount,
        externalRequests,
        errors,
      };
      await writeFile(
        path.join(artifacts, `annotation-interaction-${artifactId}.json`),
        JSON.stringify(diagnostics, null, 2),
        "utf8",
      );
      assert.equal(apiRequestCount, 0);
      assert.deepEqual(externalRequests, []);
      assert.deepEqual(errors, []);
      console.log(
        `Real-pointer annotation interaction checks captured under ${artifacts}`,
      );
    } catch (error) {
      functionalError = error;
    } finally {
      if (functionalError) {
        if (page) {
          failureScreenshotPath = path.join(
            artifacts,
            `annotation-interaction-${artifactId}-failure.png`,
          );
          try {
            await page.screenshot({ path: failureScreenshotPath, fullPage: false });
          } catch (error) {
            failureCaptureErrors.push({
              phase: "failure-screenshot",
              name: error?.name || "Error",
              message: String(error?.message ?? error).slice(0, 500),
            });
            failureScreenshotPath = null;
          }
        }
        try {
          await persistProgress();
        } catch (error) {
          failureCaptureErrors.push({
            phase: "failure-partial-write",
            name: error?.name || "Error",
            message: String(error?.message ?? error).slice(0, 500),
          });
          try {
            await writeFile(
              partialArtifactPath,
              JSON.stringify(
                {
                  fixture:
                    "tests/fixtures/tracemonkey.pdf (read-only public fixture)",
                  payloadId: payload.id,
                  contentHash: payload.contentHash,
                  browserPath,
                  openTraceRunId,
                  hostState: null,
                  workerMessages: [],
                  workerLifecycles: [],
                  cdpWorkerTrace,
                  scenarios: results,
                  errors,
                  consoleErrors,
                  failure: {
                    name: functionalError.name ?? "Error",
                    message: String(
                      functionalError.message ?? functionalError,
                    ).slice(0, 4_000),
                  },
                  failureScreenshotPath,
                  failureCaptureErrors,
                },
                null,
                2,
              ),
              "utf8",
            );
          } catch (fallbackError) {
            failureCaptureErrors.push({
              phase: "failure-partial-fallback-write",
              name: fallbackError?.name || "Error",
              message: String(fallbackError?.message ?? fallbackError).slice(
                0,
                500,
              ),
            });
          }
        }
      }
      cleanupReport = await cleanupBrowserTestResources({ browser, ownedPages: [page], server });
      restoreCDPSend?.();
      try {
        await removeTempRoot(temp);
        cleanupReport.tempRootRemoved = true;
      } catch (error) {
        cleanupReport.tempRootRemoved = false;
        cleanupReport.errors.push({
          phase: "temp-root.remove",
          name: error?.name || "Error",
          message: error?.message || String(error),
          stack: error?.stack || null,
        });
      }
      try {
        await writeFile(
          path.join(artifacts, `annotation-interaction-${artifactId}.cleanup.json`),
          JSON.stringify(cleanupReport, null, 2),
          "utf8",
        );
      } catch (error) {
        cleanupReport.errors.push({
          phase: "cleanup-report.write",
          name: error?.name || "Error",
          message: error?.message || String(error),
          stack: error?.stack || null,
        });
      }
      t.diagnostic(
        `Cleanup report: ${path.join(artifacts, `annotation-interaction-${artifactId}.cleanup.json`)}`,
      );
      if (functionalError) {
        t.diagnostic(
          `Failure evidence: ${partialArtifactPath}; screenshot: ${failureScreenshotPath ?? "unavailable"}`,
        );
      }
    }
    const finalError = attachCleanupErrors(functionalError, cleanupReport);
    if (finalError) throw finalError;
  },
);
