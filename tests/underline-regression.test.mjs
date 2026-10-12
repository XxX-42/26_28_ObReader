import { isInlineToolbarIcon } from "./inline-toolbar-icons.mjs";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { access, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import puppeteer from "puppeteer-core";
import { resolveBrowserPath } from "./browser-path.mjs";
import {
  attachCleanupErrors,
  cleanupBrowserTestResources,
  observeBrowserTestChildStderr,
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
import { withTestNetworkFirewall } from "./test-network-firewall.mjs";

const dist = path.join(root, "dist", "pdf-web-reader");
const fixture = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const artifacts = path.join(root, "tests", "artifacts");
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

function findNestedRectPairs(rangeRects, textNodeRects) {
  const positiveRects = rangeRects.filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  return positiveRects.flatMap((rangeRect) =>
    textNodeRects
      .filter(
        (textRect) =>
          Math.abs(rangeRect.x - textRect.x) < 0.75 &&
          Math.abs(rangeRect.right - textRect.right) < 0.75 &&
          Math.abs(rangeRect.bottom - textRect.bottom) >= 1 &&
          Math.abs(rangeRect.bottom - textRect.bottom) <= 6,
      )
      .map((textRect) => ({
        rangeRect,
        textRect,
        bottomDelta: rangeRect.bottom - textRect.bottom,
      })),
  );
}

function mapQuadsToScreen(annotation) {
  const { left, width, center, pdfWidth } = annotation.pageGeometry;
  const scale = width / pdfWidth;
  const rects = [];
  for (let index = 0; index < annotation.quadPoints.length; index += 8) {
    const quad = annotation.quadPoints.slice(index, index + 8);
    const x0 = left + quad[0] * scale;
    const x1 = left + quad[2] * scale;
    rects.push({ left: Math.min(x0, x1), right: Math.max(x0, x1), center });
  }
  return rects;
}

function countTextRows(textNodeRects, pageCenter) {
  const rows = [];
  for (const rect of [...textNodeRects].sort(
    (left, right) => left.y - right.y,
  )) {
    const column = rect.x + rect.width / 2 < pageCenter ? "left" : "right";
    const row = rows.find((candidate) => {
      if (candidate.column !== column) return false;
      const overlap =
        Math.min(candidate.bottom, rect.bottom) -
        Math.max(candidate.top, rect.y);
      return overlap > Math.min(candidate.height, rect.height) * 0.4;
    });
    if (row) {
      row.top = Math.min(row.top, rect.y);
      row.bottom = Math.max(row.bottom, rect.bottom);
      row.height = row.bottom - row.top;
    } else {
      rows.push({
        column,
        top: rect.y,
        bottom: rect.bottom,
        height: rect.height,
      });
    }
  }
  return rows;
}

function normalizeQuadPoints(points) {
  return points.map((point) => Math.round(point * 1000) / 1000);
}

function assertQuadPointsMatchTextRects(selection, label) {
  const actual = selection.annotation.quadPoints;
  const expected = selection.expectedQuadPoints;
  assert.equal(
    actual.length,
    expected.length,
    `${label}: serialized QuadPoints count should match independently mapped text-node rectangles`,
  );
  for (let index = 0; index < actual.length; index += 1) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) < 1,
      `${label}: QuadPoints[${index}] ${actual[index]} differs from the text-node viewport mapping ${expected[index]}`,
    );
  }
}

function settleWithin(promise, milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), milliseconds);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve({ value });
      },
      (error) => {
        clearTimeout(timer);
        resolve({ error });
      },
    );
  });
}

function appendErrorDetails(error, details) {
  const oldMessage = error.message || String(error);
  const oldStack = error.stack;
  error.message = `${oldMessage}\n${details}`;
  if (typeof oldStack === "string") {
    error.stack = oldStack.replace(oldMessage, error.message);
  }
}

function buildUnderlineOpenTraceScript({ traceAppOpen = false } = {}) {
  return `(() => {
    const MAX_RECORDS = 900;
    const MAX_SAMPLES = 220;
    const records = [];
    const samples = [];
    const tasks = [];
    const workers = [];
    const channels = [];
    const errors = [];
    const objectIds = new WeakMap();
    const portChannels = new WeakMap();
    const workerIds = new WeakMap();
    const workerPendingCallbacks = new WeakMap();
    const observedPromises = new WeakMap();
    let nextObjectId = 1;
    let nextNativeWorkerId = 1;
    let callSequence = 0;
    let sampleTimer = null;
    let installed = false;

    const identify = (value, prefix) => {
      if ((typeof value !== "object" || value === null) && typeof value !== "function") return null;
      let id = objectIds.get(value);
      if (!id) {
        id = prefix + "-" + nextObjectId++;
        objectIds.set(value, id);
      }
      return id;
    };
    const record = (type, fields = {}) => {
      records.push({ at: performance.now(), type, ...fields });
      if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
    };
    const shortError = (error) => ({
      name: error?.name || typeof error,
      message: String(error?.message || error || "").slice(0, 240),
    });
    const safeWorkerUrl = (value) => {
      try {
        const url = new URL(String(value), location.href);
        return { protocol: url.protocol, origin: url.origin, pathname: url.protocol === "blob:" ? "[blob worker module]" : url.pathname };
      } catch {
        return { kind: typeof value };
      }
    };
    const summarizeMessage = (message) => {
      if (typeof message === "string") return { kind: "string", value: message.slice(0, 80) };
      if (message instanceof ArrayBuffer) return { kind: "ArrayBuffer", byteLength: message.byteLength };
      if (ArrayBuffer.isView(message)) return { kind: message.constructor.name, byteLength: message.byteLength };
      if (!message || typeof message !== "object") return { kind: typeof message };
      const summary = { kind: message.constructor?.name || "Object" };
      for (const key of ["sourceName", "targetName", "action", "callbackId", "streamId", "desiredSize", "done", "start", "version", "ready", "name", "type"]) {
        const value = message[key];
        if (["string", "number", "boolean"].includes(typeof value)) summary[key] = typeof value === "string" ? value.slice(0, 100) : value;
      }
      if (message.data !== undefined) {
        const value = message.data;
        summary.dataKind = value === null ? "null" : value?.constructor?.name || typeof value;
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) summary.dataByteLength = value.byteLength;
        else if (value && typeof value === "object") summary.dataKeys = Object.keys(value).slice(0, 20);
      }
      if (message.reason !== undefined) summary.reason = shortError(message.reason);
      if (message.error !== undefined) summary.error = shortError(message.error);
      return summary;
    };
    const shouldTraceWorkerMessage = (summary) => {
      if (summary.callbackId !== undefined && summary.callbackId !== null) return true;
      const action = String(summary.action || summary.value || "");
      return /^(test|ready|configure|getdocrequest|getdoc|dataloaded|getpage|terminate|password|docprogress|pdfmanagerready|unsupportedfeature)$/i.test(action) || /(error|exception|password)/i.test(action);
    };
    const workerPendingSnapshot = (worker) => {
      const pending = workerPendingCallbacks.get(worker);
      return pending ? [...pending.entries()].slice(-40).map(([callbackId, action]) => ({ callbackId, action })) : [];
    };
    const recordWorkerMessage = (worker, direction, message, extra = {}) => {
      const summary = summarizeMessage(message);
      const callbackId = summary.callbackId;
      const pending = workerPendingCallbacks.get(worker) || new Map();
      if (!workerPendingCallbacks.has(worker)) workerPendingCallbacks.set(worker, pending);
      if (callbackId !== undefined && callbackId !== null) {
        if (direction === "postMessage") pending.set(callbackId, summary.action || "unknown");
        else pending.delete(callbackId);
      }
      if (!shouldTraceWorkerMessage(summary)) return;
      record("worker." + direction, {
        workerId: workerIds.get(worker) || null,
        message: summary,
        pendingCallbackCount: pending.size,
        pendingCallbacks: workerPendingSnapshot(worker),
        ...extra,
      });
    };
    const observePromise = (promise, label, owner) => {
      if (!promise || typeof promise.then !== "function") return null;
      if (observedPromises.has(promise)) return observedPromises.get(promise);
      const state = { status: "pending-at-observe", label, owner };
      observedPromises.set(promise, state);
      record("promise.pending", { label, owner });
      promise.then(
        (value) => {
          state.status = "resolved";
          state.settledAt = performance.now();
          state.result = value && typeof value === "object" ? {
            id: identify(value, "proxy"),
            numPages: Number.isFinite(value.numPages) ? value.numPages : null,
            hasLoadingTask: !!value.loadingTask,
            loadingTaskId: value.loadingTask ? identify(value.loadingTask, "task") : null,
            fingerprintCount: Array.isArray(value.fingerprints) ? value.fingerprints.length : null,
          } : { kind: typeof value };
          record("promise.resolved", { label, owner, result: state.result });
        },
        (error) => {
          state.status = "rejected";
          state.settledAt = performance.now();
          state.error = shortError(error);
          record("promise.rejected", { label, owner, error: state.error });
        },
      );
      return state;
    };
    const promiseState = (promise) => {
      if (!promise || typeof promise.then !== "function") return { present: false };
      const state = observedPromises.get(promise);
      return state ? { present: true, status: state.status, label: state.label, owner: state.owner, error: state.error || null, result: state.result || null } : { present: true, status: "not-observed" };
    };
    const safeKeys = (value) => {
      try { return Reflect.ownKeys(value).map((key) => typeof key === "symbol" ? String(key) : key).slice(0, 60); }
      catch { return []; }
    };
    const describeMap = (value) => {
      if (!(value instanceof Map)) return null;
      return { size: value.size, keys: [...value.keys()].slice(0, 40) };
    };
    const describeCallbackStorage = (value) => {
      if (value instanceof Map) return { kind: "Map", size: value.size, callbackIds: [...value.keys()].slice(0, 40) };
      if (value instanceof Set) return { kind: "Set", size: value.size, callbackIds: [...value.values()].slice(0, 40) };
      if (Array.isArray(value)) return { kind: "Array", size: value.length, callbackIds: value.slice(0, 40).map((_, index) => index) };
      if (value && typeof value === "object") {
        const keys = Reflect.ownKeys(value).map((key) => typeof key === "symbol" ? String(key) : key);
        return { kind: value.constructor?.name || "Object", size: keys.length, callbackIds: keys.slice(0, 40) };
      }
      return value === undefined || value === null ? null : { kind: typeof value, value: String(value).slice(0, 80) };
    };
    const summarizeHandler = (handler) => {
      if (!handler) return null;
      const channel = handler.comObj ? portChannels.get(handler.comObj) : null;
      return {
        className: handler.constructor?.name || null,
        keys: safeKeys(handler),
        sourceName: typeof handler.sourceName === "string" ? handler.sourceName : null,
        targetName: typeof handler.targetName === "string" ? handler.targetName : null,
        channelId: channel?.id || null,
        callbackMaps: {
          callbacks: describeMap(handler.callbacks),
          _callbacks: describeMap(handler._callbacks),
          callbackCapabilities: describeCallbackStorage(handler.callbackCapabilities),
        },
        callbackStoragePrivateOrUnavailable: handler.callbackCapabilities == null && handler.callbacks == null && handler._callbacks == null,
      };
    };
    const summarizeWorker = (worker) => {
      if (!worker) return null;
      const port = worker.port || worker._port || null;
      const messageHandler = worker.messageHandler || null;
      const webWorker = worker._webWorker || worker.webWorker || null;
      return {
        id: identify(worker, "pdfworker"),
        className: worker.constructor?.name || null,
        keys: safeKeys(worker),
        destroyed: typeof worker.destroyed === "boolean" ? worker.destroyed : null,
        portPresent: !!port,
        portType: port?.constructor?.name || null,
        portChannelId: port ? portChannels.get(port)?.id || null : null,
        hasNativeWorker: !!webWorker,
        nativeWorkerId: webWorker ? workerIds.get(webWorker) || null : null,
        pendingCallbacks: webWorker ? workerPendingSnapshot(webWorker) : [],
        pendingGetDocCallbacks: webWorker ? workerPendingSnapshot(webWorker).filter((entry) => /getdoc/i.test(entry.action)) : [],
        messageHandler: summarizeHandler(messageHandler),
        promise: promiseState(worker.promise),
        readyCapabilityPromise: promiseState(worker._readyCapability?.promise),
      };
    };
    const summarizeTransport = (transport) => {
      if (!transport) return null;
      return {
        className: transport.constructor?.name || null,
        keys: safeKeys(transport),
        destroyed: typeof transport.destroyed === "boolean" ? transport.destroyed : null,
        messageHandler: summarizeHandler(transport.messageHandler),
        loadingTaskId: transport.loadingTask ? identify(transport.loadingTask, "task") : null,
        pageCacheSize: transport.pageCache instanceof Map ? transport.pageCache.size : null,
      };
    };
    const summarizeTask = (task) => {
      if (!task) return null;
      const id = identify(task, "task");
      if (task._worker) trackPdfWorker(task._worker, id);
      const tracked = tasks.find((entry) => entry.task === task);
      return {
        id,
        docId: typeof task.docId === "string" ? task.docId : null,
        destroyed: typeof task.destroyed === "boolean" ? task.destroyed : null,
        trackedFrom: tracked?.source || null,
        assignedAt: tracked?.assignedAt || null,
        promise: promiseState(task.promise),
        worker: summarizeWorker(task._worker),
        transport: summarizeTransport(task._transport),
      };
    };
    const trackTask = (task, source) => {
      if (!task || (typeof task !== "object" && typeof task !== "function")) return;
      let tracked = tasks.find((entry) => entry.task === task);
      if (tracked) return;
      tracked = { task, source, assignedAt: performance.now(), destroyWrapped: false };
      tasks.push(tracked);
      const id = identify(task, "task");
      record("loadingTask.assigned", { id, docId: task.docId || null, source });
      observePromise(task.promise, "pdfLoadingTask.promise", id);
      if (typeof task.destroy === "function") {
        try {
          const originalDestroy = task.destroy;
          task.destroy = function(...args) {
            record("loadingTask.destroy.start", { id, destroyed: this.destroyed === true });
            let result;
            try { result = originalDestroy.apply(this, args); }
            catch (error) { record("loadingTask.destroy.throw", { id, error: shortError(error) }); throw error; }
            if (result && typeof result.then === "function") result.then(
              () => record("loadingTask.destroy.resolved", { id }),
              (error) => record("loadingTask.destroy.rejected", { id, error: shortError(error) }),
            );
            return result;
          };
          tracked.destroyWrapped = task.destroy !== originalDestroy;
        } catch (error) {
          errors.push({ stage: "wrap task.destroy", error: shortError(error) });
        }
      }
      trackPdfWorker(task._worker, id);
    };
    const trackPdfWorker = (worker, taskId) => {
      if (!worker || (typeof worker !== "object" && typeof worker !== "function")) return;
      let tracked = workers.find((entry) => entry.worker === worker);
      if (tracked) return;
      tracked = { worker, taskId, id: identify(worker, "pdfworker") };
      workers.push(tracked);
      observePromise(worker.promise, "PDFWorker.promise", tracked.id);
      observePromise(worker._readyCapability?.promise, "PDFWorker._readyCapability.promise", tracked.id);
      record("pdfWorker.observed", { id: tracked.id, taskId, state: summarizeWorker(worker) });
    };
    const callOutcome = (promise, label, callId) => {
      if (!promise || typeof promise.then !== "function") return;
      promise.then(
        () => record(label + ".resolved", { callId }),
        (error) => record(label + ".rejected", { callId, error: shortError(error) }),
      );
    };
    const wrapMethod = (object, name, label) => {
      if (!object || typeof object[name] !== "function" || object[name].__underlineOpenTrace) return;
      const original = object[name];
      const wrapped = function(...args) {
        const callId = label + "-" + (++callSequence);
        const activeTask = window.PDFViewerApplication?.pdfLoadingTask || null;
        record(label + ".start", { callId, activeTask: activeTask ? { id: identify(activeTask, "task"), destroyed: activeTask.destroyed === true } : null, args: args.slice(0, 3).map((value) => value === null ? null : typeof value) });
        let result;
        try { result = original.apply(this, args); }
        catch (error) { record(label + ".throw", { callId, error: shortError(error) }); throw error; }
        callOutcome(result, label, callId);
        return result;
      };
      Object.defineProperty(wrapped, "__underlineOpenTrace", { value: true });
      try { object[name] = wrapped; }
      catch (error) { errors.push({ stage: "wrap " + label, error: shortError(error) }); }
    };
    const channelPending = (channel) => [...channel.pending.entries()].slice(-40).map(([callbackId, action]) => ({ callbackId, action }));
    const recordPortMessage = (channel, portSide, direction, message) => {
      const summary = summarizeMessage(message);
      const callbackId = summary.callbackId;
      if (callbackId !== undefined && callbackId !== null) {
        if (direction === "send") channel.pending.set(callbackId, summary.action || "unknown");
        else channel.pending.delete(callbackId);
      }
      record("worker.port." + direction, {
        channelId: channel.id,
        portSide,
        message: summary,
        pendingCallbackCount: channel.pending.size,
        pendingCallbacks: channelPending(channel),
      });
    };
    const installWorkerTransportTrace = () => {
      try {
        const NativeWorker = window.Worker;
        if (typeof NativeWorker === "function" && NativeWorker.prototype) {
          const nativePost = NativeWorker.prototype.postMessage;
          const nativeTerminate = NativeWorker.prototype.terminate;
          if (typeof nativePost === "function" && !nativePost.__underlineOpenTrace) {
            const wrappedPost = function(message, ...args) {
              recordWorkerMessage(this, "postMessage", message, { transferCount: Array.isArray(args[0]) ? args[0].length : null });
              return nativePost.call(this, message, ...args);
            };
            Object.defineProperty(wrappedPost, "__underlineOpenTrace", { value: true });
            NativeWorker.prototype.postMessage = wrappedPost;
          }
          if (typeof nativeTerminate === "function" && !nativeTerminate.__underlineOpenTrace) {
            const wrappedTerminate = function(...args) {
              record("worker.terminate", { workerId: workerIds.get(this) || null });
              return nativeTerminate.apply(this, args);
            };
            Object.defineProperty(wrappedTerminate, "__underlineOpenTrace", { value: true });
            NativeWorker.prototype.terminate = wrappedTerminate;
          }
          const WrappedWorker = new Proxy(NativeWorker, {
            construct(target, args, newTarget) {
              const worker = Reflect.construct(target, args, newTarget === WrappedWorker ? target : newTarget);
              const id = "native-worker-" + nextNativeWorkerId++;
              workerIds.set(worker, id);
              const entry = { id, url: safeWorkerUrl(args[0]), options: args[1] && typeof args[1] === "object" ? { type: args[1].type || null, name: args[1].name || null, credentials: args[1].credentials || null } : null };
              workers.push({ nativeWorker: worker, ...entry });
              record("worker.spawn", entry);
              worker.addEventListener("message", (event) => recordWorkerMessage(worker, "message", event.data));
              worker.addEventListener("messageerror", () => record("worker.messageerror", { workerId: id }));
              worker.addEventListener("error", (event) => record("worker.error", { workerId: id, message: String(event.message || "").slice(0, 240), filename: safeWorkerUrl(event.filename || ""), line: event.lineno || null, column: event.colno || null }));
              return worker;
            },
          });
          window.Worker = WrappedWorker;
        }
      } catch (error) {
        errors.push({ stage: "install Worker trace", error: shortError(error) });
      }

      try {
        const NativeMessagePort = window.MessagePort;
        const NativeMessageChannel = window.MessageChannel;
        if (NativeMessagePort?.prototype) {
          const prototype = NativeMessagePort.prototype;
          const originalPost = prototype.postMessage;
          const originalAdd = prototype.addEventListener;
          const originalRemove = prototype.removeEventListener;
          const wrappedListeners = new WeakMap();
          if (typeof originalPost === "function" && !originalPost.__underlineOpenTrace) {
            const wrappedPost = function(message, ...args) {
              const link = portChannels.get(this);
              if (link) recordPortMessage(link.channel, link.side, "send", message);
              return originalPost.call(this, message, ...args);
            };
            Object.defineProperty(wrappedPost, "__underlineOpenTrace", { value: true });
            prototype.postMessage = wrappedPost;
          }
          if (typeof originalAdd === "function" && !originalAdd.__underlineOpenTrace) {
            const wrappedAdd = function(type, listener, ...args) {
              if (type !== "message" || !listener) return originalAdd.call(this, type, listener, ...args);
              let listeners = wrappedListeners.get(this);
              if (!listeners) { listeners = new WeakMap(); wrappedListeners.set(this, listeners); }
              let wrapped = listeners.get(listener);
              if (!wrapped) {
                const port = this;
                const link = portChannels.get(port);
                wrapped = function(event) {
                  if (link) recordPortMessage(link.channel, link.side, "receive", event.data);
                  if (typeof listener === "function") return listener.call(this, event);
                  return listener.handleEvent.call(listener, event);
                };
                listeners.set(listener, wrapped);
              }
              return originalAdd.call(this, type, wrapped, ...args);
            };
            Object.defineProperty(wrappedAdd, "__underlineOpenTrace", { value: true });
            prototype.addEventListener = wrappedAdd;
          }
          if (typeof originalRemove === "function" && !originalRemove.__underlineOpenTrace) {
            const wrappedRemove = function(type, listener, ...args) {
              const mapped = type === "message" ? wrappedListeners.get(this)?.get(listener) : null;
              return originalRemove.call(this, type, mapped || listener, ...args);
            };
            Object.defineProperty(wrappedRemove, "__underlineOpenTrace", { value: true });
            prototype.removeEventListener = wrappedRemove;
          }
        }
        if (typeof NativeMessageChannel === "function") {
          let WrappedMessageChannel;
          WrappedMessageChannel = new Proxy(NativeMessageChannel, {
            construct(target, args, newTarget) {
              const channelObject = Reflect.construct(target, args, newTarget === WrappedMessageChannel ? target : newTarget);
              const channel = { id: "message-channel-" + (channels.length + 1), pending: new Map() };
              channels.push(channel);
              portChannels.set(channelObject.port1, { channel, side: 1 });
              portChannels.set(channelObject.port2, { channel, side: 2 });
              record("worker.messageChannel.created", { channelId: channel.id });
              return channelObject;
            },
          });
          window.MessageChannel = WrappedMessageChannel;
        }
      } catch (error) {
        errors.push({ stage: "install MessagePort trace", error: shortError(error) });
      }
    };

    const trace = {
      installedAt: performance.now(),
      records,
      samples,
      errors,
      tasks,
      workers,
      channels,
      bootstrap: { workerConstructorPatched: false, messageChannelPatched: false },
      snapshot() {
        const app = window.PDFViewerApplication;
        const task = app?.pdfLoadingTask || null;
        const pdfDocument = app?.pdfDocument || null;
        const viewer = app?.pdfViewer || null;
        const pageView = viewer?.getPageView?.(0) || viewer?._pages?.[0] || null;
        const pageElement = document.querySelector('.page[data-page-number="1"]');
        const annotationDiv = pageElement?.querySelector(".annotationLayer") || null;
        const editorDiv = pageElement?.querySelector(".annotationEditorLayer") || null;
        const viewerContainer = document.getElementById("viewerContainer");
        const rect = (element) => {
          if (!element) return null;
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return { x: Math.round(box.x * 10) / 10, y: Math.round(box.y * 10) / 10, width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10, display: style.display, visibility: style.visibility, opacity: style.opacity, connected: element.isConnected };
        };
        const handler = task?._transport?.messageHandler;
        const callbackStorage = handler?.callbackCapabilities ?? handler?.callbacks ?? handler?._callbacks ?? null;
        let workerSrc = null;
        try {
          const raw = window.pdfjsLib?.GlobalWorkerOptions?.workerSrc || window.PDFJS?.GlobalWorkerOptions?.workerSrc || null;
          workerSrc = raw ? safeWorkerUrl(raw) : null;
        } catch {}
        return {
          at: performance.now(),
          appReady: !!app,
          appInitialized: app?.initialized === true,
          currentTask: summarizeTask(task),
          currentTaskMatchesPdfDocument: !!task && pdfDocument?.loadingTask === task,
          pdfDocument: pdfDocument ? { id: identify(pdfDocument, "proxy"), numPages: pdfDocument.numPages, fingerprints: Array.isArray(pdfDocument.fingerprints) ? pdfDocument.fingerprints : null, loadingTaskId: pdfDocument.loadingTask ? identify(pdfDocument.loadingTask, "task") : null } : null,
          pdfViewerDocument: viewer?.pdfDocument ? { id: identify(viewer.pdfDocument, "proxy"), numPages: viewer.pagesCount, sameAsAppDocument: viewer.pdfDocument === pdfDocument } : null,
          viewer: viewer ? { currentPageNumber: viewer.currentPageNumber, currentScale: viewer.currentScale, currentScaleValue: viewer.currentScaleValue, pagesCount: viewer.pagesCount, pageViews: Array.isArray(viewer._pages) ? viewer._pages.length : null } : null,
          page1: pageView ? { pageNumber: pageView.id ?? pageView.pdfPage?.pageNumber ?? null, pdfPageId: pageView.pdfPage ? identify(pageView.pdfPage, "page") : null, renderingState: pageView.renderingState ?? null, pdfPagePresent: !!pageView.pdfPage, annotationLayerBuilderPresent: !!pageView.annotationLayer, annotationLayerBuilderKeys: pageView.annotationLayer ? safeKeys(pageView.annotationLayer) : [], annotationBuilderDivConnected: !!pageView.annotationLayer?.div?.isConnected, annotationBuilderChildCount: pageView.annotationLayer?.div?.childElementCount ?? null, domPage: rect(pageElement), canvas: rect(pageElement?.querySelector("canvas")), textLayer: rect(pageElement?.querySelector(".textLayer")), annotationLayer: rect(annotationDiv), annotationElementCount: annotationDiv?.children?.length ?? null, annotationEditorLayer: rect(editorDiv), annotationEditorElementCount: editorDiv?.children?.length ?? null } : { pageViewPresent: false, domPage: rect(pageElement) },
          viewport: viewerContainer ? { scrollTop: viewerContainer.scrollTop, scrollLeft: viewerContainer.scrollLeft, scrollHeight: viewerContainer.scrollHeight, clientHeight: viewerContainer.clientHeight, scrollWidth: viewerContainer.scrollWidth, clientWidth: viewerContainer.clientWidth, rect: rect(viewerContainer) } : null,
          documentState: { loadingTaskId: identify(document, "dom"), readyState: document.readyState, workerSrc },
          taskHistory: tasks.map((entry) => ({ id: identify(entry.task, "task"), docId: typeof entry.task.docId === "string" ? entry.task.docId : null, source: entry.source, assignedAt: entry.assignedAt, destroyed: entry.task.destroyed === true, promise: promiseState(entry.task.promise), worker: summarizeWorker(entry.task._worker), transport: summarizeTransport(entry.task._transport) })),
          nativeWorkers: workers.filter((entry) => entry.nativeWorker).map(({ id, url, options }) => ({ id, url, options })),
          channels: channels.map((channel) => ({ id: channel.id, pendingCallbackCount: channel.pending.size, pendingCallbacks: channelPending(channel) })),
          callbackMap: callbackStorage ? { accessible: true, storage: handler?.callbackCapabilities === callbackStorage ? "callbackCapabilities" : handler?.callbacks === callbackStorage ? "callbacks" : "_callbacks", ...describeCallbackStorage(callbackStorage) } : { accessible: false, reason: "MessageHandler exposes no callback storage value; direct Worker callbackId traffic is traced", handlerKeys: safeKeys(handler || {}) },
          counts: { events: records.length, samples: samples.length, tasks: tasks.length, workers: workers.length, channels: channels.length },
          recentSamples: samples.slice(-12),
          recentEvents: records.slice(-160),
          instrumentationErrors: errors.slice(-30),
        };
      },
      stop() {
        if (sampleTimer !== null) clearInterval(sampleTimer);
        sampleTimer = null;
      },
    };
    window.__underlinePdfOpenTrace = trace;
    window.__installUnderlinePdfOpenTrace = () => {
      if (installed) return { installed, errors: errors.slice(-10) };
      installed = true;
      const app = window.PDFViewerApplication;
      if (!app) {
        errors.push({ stage: "install application hooks", error: { name: "Error", message: "PDFViewerApplication is unavailable" } });
        return { installed: false, errors: errors.slice(-10) };
      }
      try {
        const descriptor = Object.getOwnPropertyDescriptor(app, "pdfLoadingTask");
        let current = app.pdfLoadingTask;
        Object.defineProperty(app, "pdfLoadingTask", {
          configurable: descriptor?.configurable !== false,
          enumerable: descriptor?.enumerable ?? true,
          get() { return descriptor?.get ? descriptor.get.call(this) : current; },
          set(value) {
            if (descriptor?.set) descriptor.set.call(this, value);
            else current = value;
            if (value) trackTask(value, "PDFViewerApplication.pdfLoadingTask assignment");
            else record("loadingTask.cleared", {});
          },
        });
        if (current) trackTask(current, "baseline at trace installation");
      } catch (error) {
        errors.push({ stage: "observe pdfLoadingTask assignments", error: shortError(error) });
        if (app.pdfLoadingTask) trackTask(app.pdfLoadingTask, "baseline after assignment-hook failure");
      }
      if (${traceAppOpen}) wrapMethod(app, "open", "app.open");
      wrapMethod(app, "close", "app.close");
      wrapMethod(app, "load", "app.load");
      wrapMethod(app.pdfViewer, "setDocument", "pdfViewer.setDocument");
      const bus = app.eventBus;
      if (bus && typeof bus.dispatch === "function") {
        try {
          const originalDispatch = bus.dispatch;
          bus.dispatch = function(name, ...args) {
            if (["documentloaded", "pagesinit", "pagesloaded", "pagerender", "pagerendered", "annotationlayerrendered", "annotationeditorlayerrendered", "pagechanging", "pagesdestroy", "updateviewarea"].includes(name)) {
              const detail = args[0] || {};
              const pageNumber = detail.pageNumber ?? detail.source?.id ?? detail.pageIndex ?? null;
              record("eventBus." + name, { pageNumber, documentId: detail.pdfDocument ? identify(detail.pdfDocument, "proxy") : null, sourceId: detail.source ? identify(detail.source, "event-source") : null, hasError: !!detail.error, error: detail.error ? shortError(detail.error) : null, annotationLayerPresent: !!detail.source?.annotationLayer?.div, annotationDivConnected: !!detail.source?.annotationLayer?.div?.isConnected });
            }
            return originalDispatch.call(this, name, ...args);
          };
        } catch (error) {
          errors.push({ stage: "wrap EventBus.dispatch", error: shortError(error) });
        }
      }
      if (app.pdfLoadingTask) trackTask(app.pdfLoadingTask, "baseline at trace installation");
      const sample = () => {
        try {
          if (samples.length < MAX_SAMPLES) samples.push(trace.snapshot());
        } catch (error) {
          errors.push({ stage: "periodic sample", error: shortError(error) });
        }
      };
      sample();
      sampleTimer = setInterval(sample, 500);
      record("trace.installed", { initialTask: app.pdfLoadingTask ? identify(app.pdfLoadingTask, "task") : null });
      return { installed, taskCount: tasks.length, workerCount: workers.length, channelCount: channels.length, errors: errors.slice(-10) };
    };

    installWorkerTransportTrace();
    trace.bootstrap.workerConstructorPatched = typeof window.Worker === "function";
    trace.bootstrap.messageChannelPatched = typeof window.MessageChannel === "function";
  })();`;
}

test(
  "underline selection geometry stays single-stroke across text runs and columns",
  { timeout: 150_000 },
  async (t) => {
    const testSignal = t.signal;
    let temp;
    let adapter;
    let mainSource;
    let payload;
    let harness;
    let logicalAssetRoot;
    let output;
    let baseUrl;
    let captureId = "setup-pending";
    let browser;
    let browserStderrObserver;
    let server;
    let serverListenPromise;
    let browserLaunchPromise;
    let page;
    let viewer;
    let primaryError = null;
    let cleanupReport = null;
    let cleanupPromise = null;
    let phase = "setup";
    let activeOperation = null;
    let apiRequestCount = 0;
    const externalRequests = [];
    const pageErrors = [];
    const consoleErrors = [];
    const runStartedAt = Date.now();
    const runId = `${runStartedAt}-${process.pid}`;
    let successArtifactId;
    const diagnosticsEnabled = process.env.PDF_READER_OPEN_TRACE === "1";
    const phaseHistory = diagnosticsEnabled
      ? [{ at: runStartedAt, elapsedMs: 0, phase: "setup" }]
      : [];
    const lifecycleTrace = { events: [], droppedEvents: 0 };
    const cdpWorkerTrace = { events: [], droppedEvents: 0 };
    const cdpWorkerByTargetId = new Map();
    const cdpWorkerBySessionId = new Map();
    const cdpObservedSessions = new WeakSet();
    let cdpEventSequence = 0;
    let cdpWorkerSequence = 0;
    let restoreCDPSend;
    let restoreCDPOnMessage;
    let failureDiagnostics = null;
    let failureDiagnosticsPath = null;
    const pendingOwnedCreations = new Map();
    const recordLifecycle = (kind, fields = {}) => {
      if (!diagnosticsEnabled) return null;
      const item = {
        sequence: lifecycleTrace.events.length + lifecycleTrace.droppedEvents + 1,
        at: Date.now(),
        elapsedMs: Date.now() - runStartedAt,
        kind,
        ...fields,
      };
      if (lifecycleTrace.events.length < 800) {
        lifecycleTrace.events.push(item);
      } else {
        lifecycleTrace.droppedEvents += 1;
      }
      return item;
    };
    const throwIfTestAborted = () => {
      if (testSignal.aborted) {
        throw testSignal.reason ?? new Error("Node test was aborted");
      }
    };
    const awaitTestOperation = async (name, operation) => {
      activeOperation = name;
      recordLifecycle("setup-operation-start", { name });
      try {
        throwIfTestAborted();
        const result = await operation();
        throwIfTestAborted();
        recordLifecycle("setup-operation-complete", { name });
        return result;
      } catch (error) {
        recordLifecycle("setup-operation-failed", {
          name,
          errorName: String(error?.name ?? "Error").slice(0, 100),
          errorMessage: String(error?.message ?? error).slice(0, 300),
        });
        throw error;
      } finally {
        if (activeOperation === name) activeOperation = null;
      }
    };
    const trackOwnedCreation = (name, create, adopt) => {
      throwIfTestAborted();
      const entry = { name, promise: null };
      const creation = Promise.resolve().then(() => {
        throwIfTestAborted();
        return create();
      });
      entry.promise = creation.then(
        (resource) => {
          adopt?.(resource);
          pendingOwnedCreations.delete(entry);
          recordLifecycle("owned-resource-created", { name });
          return resource;
        },
        (error) => {
          pendingOwnedCreations.delete(entry);
          recordLifecycle("owned-resource-create-failed", {
            name,
            errorName: String(error?.name ?? "Error").slice(0, 100),
            errorMessage: String(error?.message ?? error).slice(0, 300),
          });
          throw error;
        },
      );
      pendingOwnedCreations.set(entry, true);
      return entry.promise;
    };
    const setPhase = (nextPhase) => {
      phase = nextPhase;
      if (!diagnosticsEnabled) return;
      const item = {
        at: Date.now(),
        elapsedMs: Date.now() - runStartedAt,
        phase: nextPhase,
      };
      phaseHistory.push(item);
      if (phaseHistory.length > 160) phaseHistory.shift();
      recordLifecycle("phase", { phase: nextPhase });
    };
    const awaitBrowserOperation = async (name, operation, fields = {}) => {
      activeOperation = name;
      recordLifecycle("browser-operation-start", { name, ...fields });
      try {
        if (testSignal.aborted) {
          throw testSignal.reason ?? new Error("Node test was aborted");
        }
        const result = await operation();
        if (testSignal.aborted) {
          throw testSignal.reason ?? new Error("Node test was aborted");
        }
        recordLifecycle("browser-operation-complete", { name, ...fields });
        return result;
      } catch (error) {
        recordLifecycle("browser-operation-failed", {
          name,
          ...fields,
          errorName: String(error?.name ?? "Error").slice(0, 100),
          errorMessage: String(error?.message ?? error).slice(0, 300),
        });
        throw error;
      } finally {
        if (activeOperation === name) activeOperation = null;
      }
    };
    const browserConnected = () => {
      if (!browser) return null;
      if (typeof browser.connected === "boolean") return browser.connected;
      return browser.isConnected?.() ?? null;
    };
    const startBrowserCleanup = (trigger) => {
      if (cleanupPromise) return cleanupPromise;
      const cleanupStartedAt = Date.now();
      recordLifecycle("cleanup-started", {
        trigger,
        phase,
        activeOperation,
        browserConnected: browserConnected(),
        serverListening: server?.listening ?? null,
      });
      cleanupPromise = (async () => {
        await Promise.allSettled(
          [...pendingOwnedCreations.keys()].map((entry) => entry.promise),
        );
        return cleanupBrowserTestResources({
          browser,
          browserObserver: browserStderrObserver,
          ownedPages: [page],
          server: server?.listening ? server : undefined,
          browserTimeoutMs: 5_000,
          processExitTimeoutMs: 2_000,
          terminateTimeoutMs: 2_000,
          killTimeoutMs: 2_000,
          serverTimeoutMs: 5_000,
        });
      })().then(
        (report) => {
          recordLifecycle("cleanup-finished", {
            trigger,
            status: report.status,
            cleanupElapsedMs: Date.now() - cleanupStartedAt,
            browser: report.browser ?? null,
            server: report.server ?? null,
          });
          return report;
        },
        (error) => {
          recordLifecycle("cleanup-failed", {
            trigger,
            cleanupElapsedMs: Date.now() - cleanupStartedAt,
            errorName: String(error?.name ?? "Error").slice(0, 100),
            errorMessage: String(error?.message ?? error).slice(0, 300),
          });
          return {
            status: "failed",
            browser: null,
            server: null,
            errors: [{
              phase: "cleanup.helper",
              name: error?.name || "Error",
              message: error?.message || String(error),
              stack: error?.stack || null,
            }],
          };
        },
      );
      return cleanupPromise;
    };
    const onTestAbort = () => {
      recordLifecycle("node-test-abort", {
        phase,
        activeOperation,
        reason: String(testSignal.reason?.message ?? testSignal.reason ?? "").slice(0, 300),
      });
      void startBrowserCleanup("node-test-abort");
    };
    testSignal.addEventListener("abort", onTestAbort, { once: true });
    if (testSignal.aborted) onTestAbort();

    try {
      assert.ok(browserPath, "Set PDF_READER_CHROME to Chrome or Edge");
      assert.deepEqual(
        await awaitTestOperation("inspect built plugin files", async () =>
          (await readdir(dist)).sort(),
        ),
        ["main.js", "manifest.json", "styles.css"],
        "The test must start from the built three-file plugin",
      );
      await awaitTestOperation("create artifacts directory", () => mkdir(artifacts, { recursive: true }));
      temp = await awaitTestOperation("create test temp root", () =>
        trackOwnedCreation(
          "temp-root",
          () => createTempRoot("underline-regression-"),
          (value) => { temp = value; },
        ),
      );
      adapter = createDiskAdapter(temp);
      mainSource = await awaitTestOperation("read built plugin source", () => readBuiltMain());
      payload = readPayloadFromMain(mainSource);
      harness = loadBundledPlugin(mainSource, adapter);
      await awaitTestOperation("load bundled test harness", () => harness.load());
      logicalAssetRoot = `${pluginRoot}/.asset-cache/${payload.id}/${payload.contentHash}`;
      output = adapter.resolve(logicalAssetRoot);
      captureId = payload.contentHash.slice(0, 12);
      successArtifactId = `${captureId}-${runId}`;
    } catch (error) {
      primaryError = error;
      cleanupReport = await startBrowserCleanup(
        testSignal.aborted ? "node-test-abort-during-setup" : "setup-failed",
      );
      testSignal.removeEventListener("abort", onTestAbort);
      if (temp) {
        try {
          await removeTempRoot(temp);
          cleanupReport.tempRootRemoved = true;
        } catch (cleanupError) {
          cleanupReport.tempRootRemoved = false;
          cleanupReport.errors.push({
            phase: "temp-root.remove",
            name: cleanupError?.name || "Error",
            message: cleanupError?.message || String(cleanupError),
            stack: cleanupError?.stack || null,
          });
          cleanupReport.status = "failed";
        }
      }
      const finalError = attachCleanupErrors(primaryError, cleanupReport);
      throw finalError ?? primaryError;
    }
    const recordCDPEvent = (event) => {
      if (!diagnosticsEnabled) return;
      const item = {
        sequence: ++cdpEventSequence,
        at: Date.now(),
        elapsedMs: Date.now() - runStartedAt,
        ...event,
      };
      if (cdpWorkerTrace.events.length < 1_800) {
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
        return { origin: null, path: String(value).slice(0, 120) };
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
        session.on("Runtime.executionContextCreated", (event) => {
          const context = event?.context ?? {};
          recordCDPEvent({
            kind: "runtime-context-created",
            ...worker,
            contextId: context.id ?? null,
            uniqueContextId: context.uniqueId ?? null,
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
            exceptionDescription: String(
              details.exception?.description ?? "",
            ).slice(0, 240),
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
        session.on("Runtime.consoleAPICalled", (event) => {
          if (event?.type !== "error") return;
          recordCDPEvent({
            kind: "runtime-console-error",
            ...worker,
            arguments: (event.args ?? []).slice(0, 4).map((argument) =>
              String(argument?.value ?? argument?.description ?? "").slice(0, 200),
            ),
          });
        });
        session.on("Inspector.targetCrashed", (event) => {
          recordCDPEvent({
            kind: "inspector-target-crashed",
            ...worker,
            reason: String(event?.reason ?? "").slice(0, 200),
          });
        });
        session.on("Target.attachedToTarget", (event) => {
          const targetInfo = event?.targetInfo ?? {};
          const childSession = session.connection?.()?._session?.(
            event?.sessionId,
          );
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
        });
        session.on("Target.detachedFromTarget", (event) => {
          const child = cdpWorkerBySessionId.get(event?.sessionId);
          if (child) {
            recordCDPEvent({
              kind: "target-detached",
              ...child,
              parentWorkerKey: worker.workerKey,
            });
          }
        });
      }
      return worker;
    };
    // Observe Puppeteer's existing Target, Runtime, Network, and Fetch traffic.
    // This probe never sends attach, enable, or resume commands of its own.
    const installCDPWorkerTrace = (targetPage) => {
      const client = targetPage._client();
      const connection = client.connection();
      const onAttached = (event) => {
        const targetInfo = event?.targetInfo ?? {};
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
        if (worker) {
          recordCDPEvent({
            kind: "target-attached",
            ...worker,
            waitingForDebugger: event?.waitingForDebugger ?? null,
          });
        } else {
          recordCDPEvent({
            kind: "target-attached-non-worker",
            targetType: targetInfo.type ?? null,
            targetId: targetInfo.targetId ?? null,
            sessionId: event?.sessionId ?? null,
            url: sanitizeTargetUrl(targetInfo.url),
            waitingForDebugger: event?.waitingForDebugger ?? null,
          });
        }
      };
      const onDetached = (event) => {
        const worker = cdpWorkerBySessionId.get(event?.sessionId);
        recordCDPEvent({
          kind: "target-detached",
          ...(worker ?? {}),
          sessionId: event?.sessionId ?? null,
          targetId: event?.targetId ?? worker?.targetId ?? null,
        });
      };
      client.on("Target.attachedToTarget", onAttached);
      client.on("Target.detachedFromTarget", onDetached);
      client.on("Target.targetCreated", (event) => {
        const targetInfo = event?.targetInfo ?? {};
        if (!["worker", "shared_worker", "service_worker"].includes(targetInfo.type)) {
          return;
        }
        const worker = getOrCreateCDPWorker(null, {
          targetInfo,
          targetId: targetInfo.targetId,
          type: targetInfo.type,
          url: sanitizeTargetUrl(targetInfo.url),
        });
        recordCDPEvent({ kind: "target-created", ...worker });
      });
      client.on("Target.targetDestroyed", (event) => {
        const worker = cdpWorkerByTargetId.get(event?.targetId);
        if (worker) {
          recordCDPEvent({ kind: "target-destroyed", ...worker });
        }
      });
      client.on("Target.targetCrashed", (event) => {
        const worker = cdpWorkerByTargetId.get(event?.targetId);
        recordCDPEvent({
          kind: "target-crashed",
          ...(worker ?? {}),
          targetId: event?.targetId ?? null,
          status: event?.status ?? null,
          errorCode: event?.errorCode ?? null,
        });
      });

      const prototype = Object.getPrototypeOf(client);
      const originalSend = prototype.send;
      const originalOnMessage = prototype.onMessage;
      const tracedOnMessage = function (message) {
        const method = message?.method;
        if (
          method === "Network.requestWillBeSent" ||
          method === "Fetch.requestPaused"
        ) {
          try {
            const params = message.params ?? {};
            const targetInfo = sessionTargetInfo(this);
            const worker = getOrCreateCDPWorker(this);
            const request = params.request ?? {};
            recordCDPEvent({
              kind:
                method === "Network.requestWillBeSent"
                  ? "network-request-will-be-sent"
                  : "fetch-request-paused",
              method,
              targetType: targetInfo.type,
              targetId: targetInfo.targetId,
              sessionId: this.id?.() ?? null,
              workerKey: worker?.workerKey ?? null,
              requestId: params.requestId ?? null,
              networkId: params.networkId ?? null,
              url: sanitizeTargetUrl(request.url),
              documentUrl: sanitizeTargetUrl(params.documentURL),
              methodName: request.method ?? null,
              resourceType: params.type ?? null,
              initiatorType: params.initiator?.type ?? null,
              frameId: params.frameId ?? null,
              loaderId: params.loaderId ?? null,
              protocolTimestamp: params.timestamp ?? null,
              protocolWallTime: params.wallTime ?? null,
              redirectHasExtraInfo: params.redirectHasExtraInfo ?? null,
              responseErrorReason: params.responseErrorReason ?? null,
            });
          } catch {
            // Keep diagnostic failures from changing Puppeteer's dispatch path.
          }
        }
        return originalOnMessage.call(this, message);
      };
      const tracedSend = function (method, params, options) {
        const worker = getOrCreateCDPWorker(this);
        const traceCommand =
          method === "Target.setAutoAttach" ||
          ["Runtime.enable", "Runtime.runIfWaitingForDebugger"].includes(
            method,
          ) ||
          [
            "Network.enable",
            "Fetch.enable",
            "Fetch.disable",
            "Fetch.continueRequest",
            "Runtime.evaluate",
            "Runtime.callFunctionOn",
          ].includes(method);
        if (!traceCommand) return originalSend.call(this, method, params, options);

        const targetInfo = sessionTargetInfo(this);
        const eventBase = {
          method,
          targetType: targetInfo.type,
          targetId: targetInfo.targetId,
          sessionId: this.id?.() ?? null,
          requestId: params?.requestId ?? null,
          executionContextId: params?.executionContextId ?? null,
          uniqueContextId: params?.uniqueContextId ?? null,
          ...(worker ?? {}),
        };
        const commandId = ++cdpEventSequence;
        recordCDPEvent({
          kind: "cdp-command-start",
          commandId,
          ...eventBase,
          autoAttach: method === "Target.setAutoAttach"
            ? {
                autoAttach: params?.autoAttach ?? null,
                flatten: params?.flatten ?? null,
                waitForDebuggerOnStart:
                  params?.waitForDebuggerOnStart ?? null,
              }
            : undefined,
          fetchConfig: method === "Fetch.enable"
            ? {
                handleAuthRequests: params?.handleAuthRequests ?? null,
                patterns: (params?.patterns ?? []).slice(0, 10),
              }
            : undefined,
        });
        let result;
        try {
          result = originalSend.call(this, method, params, options);
        } catch (error) {
          recordCDPEvent({
            kind: "cdp-command-result",
            commandId,
            ...eventBase,
            outcome: "throw",
            errorName: String(error?.name ?? "Error").slice(0, 100),
            errorMessage: String(error?.message ?? error).slice(0, 240),
          });
          throw error;
        }
        Promise.resolve(result).then(
          () =>
            recordCDPEvent({
              kind: "cdp-command-result",
              commandId,
              ...eventBase,
              outcome: "resolved",
            }),
          (error) =>
            recordCDPEvent({
              kind: "cdp-command-result",
              commandId,
              ...eventBase,
              outcome: "rejected",
              errorName: String(error?.name ?? "Error").slice(0, 100),
              errorMessage: String(error?.message ?? error).slice(0, 240),
            }),
        );
        return result;
      };
      prototype.send = tracedSend;
      prototype.onMessage = tracedOnMessage;
      restoreCDPSend = () => {
        if (prototype.send === tracedSend) prototype.send = originalSend;
      };
      restoreCDPOnMessage = () => {
        if (prototype.onMessage === tracedOnMessage) {
          prototype.onMessage = originalOnMessage;
        }
      };
    };

    try {
      throwIfTestAborted();
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
            ? "<!doctype html><title>Underline regression</title>"
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

      serverListenPromise = trackOwnedCreation(
        "fixture-server-listen",
        () => new Promise((resolve, reject) => {
          const onError = (error) => reject(error);
          server.once("error", onError);
          server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", onError);
            resolve(server.address());
          });
        }),
      );
      await awaitTestOperation("listen fixture server", () => serverListenPromise);
      serverListenPromise = null;
      baseUrl = `http://127.0.0.1:${server.address().port}`;

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
      const testView = harness.createView();
      const viewerDocument = await testView.createViewerDocument();
      const traceBootstrap = `<script>${buildUnderlineOpenTraceScript({
        traceAppOpen: diagnosticsEnabled,
      })}</script>`;
      const viewerHead = viewerDocument.match(/<head[^>]*>/i)?.[0];
      const viewerBody = viewerDocument.match(/<body[^>]*>/i)?.[0];
      const viewerDocumentWithTrace = viewerHead
        ? viewerDocument.replace(viewerHead, `${viewerHead}${traceBootstrap}`)
        : viewerBody
          ? viewerDocument.replace(viewerBody, `${viewerBody}${traceBootstrap}`)
          : `${traceBootstrap}${viewerDocument}`;
      const viewerLiteral = JSON.stringify(viewerDocumentWithTrace).replaceAll(
        "<",
        "\\u003c",
      );

      setPhase("launching the test browser");
      browserLaunchPromise = trackOwnedCreation(
        "browser-launch",
        () => launchTestBrowser(puppeteer, {
          executablePath: browserPath,
          headless: true,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        }, { testName: "underline-regression" }),
        (launchedBrowser) => {
          browser = launchedBrowser;
          try {
            const childProcess = launchedBrowser.process?.();
            browserStderrObserver = observeBrowserTestChildStderr(childProcess);
            recordLifecycle("browser-stderr-observer-installed", {
              pid: childProcess?.pid ?? null,
            });
          } catch (error) {
            recordLifecycle("browser-stderr-observer-install-failed", {
              errorName: String(error?.name ?? "Error").slice(0, 100),
              errorMessage: String(error?.message ?? error).slice(0, 300),
            });
          }
        },
      );
      try {
        await awaitTestOperation("launch test browser", () => browserLaunchPromise);
      } finally {
        browserLaunchPromise = null;
      }
      throwIfTestAborted();
      recordLifecycle("browser-launched", {
        pid: browser.process?.()?.pid ?? null,
        browserPath,
      });
      if (diagnosticsEnabled) {
        browser.on("disconnected", () =>
          recordLifecycle("browser-disconnected"),
        );
      }
      page = await awaitBrowserOperation(
        "create browser page",
        () => browser.newPage(),
      );
      recordLifecycle("page-created");
      if (diagnosticsEnabled) {
        try {
          installCDPWorkerTrace(page);
          recordLifecycle("cdp-worker-trace-installed");
        } catch (error) {
          recordLifecycle("cdp-worker-trace-install-failed", {
            errorName: String(error?.name ?? "Error").slice(0, 100),
            errorMessage: String(error?.message ?? error).slice(0, 300),
          });
        }
        page.on("close", () => recordLifecycle("page-closed"));
        page.on("frameattached", (frame) =>
          recordLifecycle("frame-attached", {
            name: frame.name() || null,
            url: sanitizeTargetUrl(frame.url()),
          }),
        );
        page.on("framedetached", (frame) =>
          recordLifecycle("frame-detached", {
            name: frame.name() || null,
            url: sanitizeTargetUrl(frame.url()),
          }),
        );
        page.on("framenavigated", (frame) =>
          recordLifecycle("frame-navigated", {
            name: frame.name() || null,
            url: sanitizeTargetUrl(frame.url()),
          }),
        );
      }
      await page.setViewport({ width: 1400, height: 1000 });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("request", (request) => {
        if (!isInlineToolbarIcon(request.url()) && new URL(request.url()).origin !== baseUrl) {
          externalRequests.push(request.url());
        }
      });
      setPhase("loading the viewer harness");
      await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
      setPhase("installing the viewer and host message harness");
      await page.setContent(`
        <!doctype html><meta charset="utf-8">
        <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%}</style>
        <iframe name="pdf-reader" title="PDF Web Reader"
          sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts"></iframe>
        <script>
          const channel = 'pdf-web-reader';
          const token = ${JSON.stringify(testView.token)};
          const documentId = 'fixtures/tracemonkey.pdf';
          const iframe = document.querySelector('iframe');
          const state = window.__hostState = { opened: 0, saves: 0, savedData: null, savedDataByteLength: 0, events: [], openRequests: [], errors: [] };
          let fixtureBytes;
          const recordOpenRequest = (data, reason) => {
            state.openRequests.push({
              at: performance.now(),
              reason,
              documentId,
              byteLength: data?.byteLength ?? null,
            });
          };
          const postOpen = (data, reason) => {
            recordOpenRequest(data, reason);
            iframe.contentWindow.postMessage({channel, type:'open', token, data, documentId, readOnly:false, autoSave:false}, '*', [data]);
          };
          window.addEventListener('message', event => {
            if (event.source !== iframe.contentWindow) return;
            const message = event.data;
            if (!message || message.channel !== channel || message.token !== token) return;
            const record = {
              at: performance.now(),
              type: message.type,
              documentId: message.documentId ?? null,
              requestId: message.requestId ?? null,
              revision: message.revision ?? null,
              openRequest: message.openRequest ?? null,
              code: message.code ?? null,
              message: message.message ?? null,
              byteLength: message.data?.byteLength ?? null,
            };
            state.events.push(record);
            if (message.type === 'ready') {
              const data = fixtureBytes.slice(0);
              postOpen(data, 'initial-ready');
            } else if (message.type === 'opened') {
              state.opened += 1;
              record.openedCount = state.opened;
            } else if (message.type === 'save') {
              state.saves += 1;
              state.savedData = message.data.slice(0);
              state.savedDataByteLength = state.savedData.byteLength;
              record.saveCount = state.saves;
              iframe.contentWindow.postMessage({channel, type:'saved', token, documentId, requestId:message.requestId, revision:message.revision}, '*');
              state.events.push({
                at: performance.now(),
                direction: 'host-to-viewer',
                type: 'saved-ack',
                documentId,
                requestId: message.requestId ?? null,
                revision: message.revision ?? null,
                saveCount: state.saves,
              });
            } else if (message.type === 'error') {
              state.errors.push(record);
            }
          });
          window.__reopenSavedData = () => {
            const data = state.savedData.slice(0);
            postOpen(data, 'saved-data-reopen');
          };
          window.__reopenFixture = () => {
            const data = fixtureBytes.slice(0);
            postOpen(data, 'fixture-reopen');
          };
          (async () => {
            fixtureBytes = await fetch('/fixtures/tracemonkey.pdf').then(response => {
              if (!response.ok) throw new Error('fixture fetch failed');
              return response.arrayBuffer();
            });
            iframe.srcdoc = ${viewerLiteral};
          })().catch(error => { state.error = error.message; });
        </script>
      `);
      const waitForOpenedOrError = async (
        expectedCount,
        eventStart,
        timeout,
        description,
      ) => {
        recordLifecycle("opened-wait-start", {
          expectedCount,
          eventStart,
          timeoutMs: timeout,
          description,
        });
        let handle;
        try {
          handle = await page.waitForFunction(
            ({ expectedCount, eventStart }) => {
              const state = window.__hostState;
              if (!state) return false;
              if (state.error) {
                return { kind: "host-harness-error", error: state.error };
              }
              const error = state.events
                .slice(eventStart)
                .find((event) => event.type === "error");
              if (error) return { kind: "error", error };
              if (state.opened >= expectedCount) {
                return { kind: "opened", opened: state.opened };
              }
              return false;
            },
            { timeout },
            { expectedCount, eventStart },
          );
          const result = await handle.jsonValue();
          if (result.kind !== "opened") {
            throw new Error(
              `${description} failed before opened(${expectedCount}): ${JSON.stringify(result.error)}`,
            );
          }
          recordLifecycle("opened-wait-complete", {
            expectedCount,
            description,
            result,
          });
          return result;
        } catch (error) {
          recordLifecycle("opened-wait-failed", {
            expectedCount,
            description,
            errorName: String(error?.name ?? "Error").slice(0, 100),
            errorMessage: String(error?.message ?? error).slice(0, 300),
          });
          throw error;
        } finally {
          if (handle) await handle.dispose();
        }
      };

      setPhase("waiting for the initial viewer open");
      await waitForOpenedOrError(1, 0, 45_000, "Initial PDF open");
      setPhase("waiting for the initial text and annotation layers");
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
      const openTraceInstall = await viewer.evaluate(() => {
        const result = window.__installUnderlinePdfOpenTrace?.() ?? {
          installed: false,
          errors: ["trace bootstrap did not run"],
        };
        window.__underlinePdfOpenTraceInstallResult = result;
        return result;
      });

      const initial = await viewer.evaluate(() => {
        const layer = document.querySelector(
          '.page[data-page-number="1"] .textLayer',
        );
        const spans = [...layer.querySelectorAll("span")];
        const textNodes = [];
        const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (walker.currentNode.textContent.trim())
            textNodes.push(walker.currentNode);
        }
        return {
          text: textNodes.map((node) => node.textContent).join(""),
          spans: spans.map((span) => {
            const rect = span.getBoundingClientRect();
            return {
              text: span.textContent,
              html: span.innerHTML,
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              fontSize: getComputedStyle(span).fontSize,
            };
          }),
        };
      });
      assert.match(initial.text, /Dynamic languages/);
      assert.match(initial.text, /programs\./);
      assert.match(initial.text, /Compilers for statically typed languages/);
      assert.match(initial.text, /performance\./);

      const selectAndCreateAnnotation = async ({
        mode = 10,
        annotationType = mode,
        start,
        startDelta = 0,
        end,
        endDelta = 0,
        backwards = false,
        elementBoundaries = false,
      }) => {
        await viewer.evaluate(
          (mode) =>
            PDFViewerApplication.eventBus.dispatch(
              "switchannotationeditormode",
              { mode },
            ),
          mode,
        );
        const geometry = await viewer.evaluate(
          async ({
            mode,
            annotationType,
            start,
            startDelta,
            end,
            endDelta,
            backwards,
            elementBoundaries,
          }) => {
            const textLayer = document.querySelector(
              '.page[data-page-number="1"] .textLayer',
            );
            const spans = [...textLayer.querySelectorAll("span")];
            const startIndex = spans.findIndex((span) =>
              span.textContent.includes(start),
            );
            const endIndex = spans.findIndex((span) =>
              span.textContent.includes(end),
            );
            if (startIndex < 0 || endIndex < startIndex) {
              throw new Error(
                `Could not resolve selection anchors: ${start} … ${end}`,
              );
            }
            const startSpan = spans[startIndex];
            const endSpan = spans[endIndex];
            const startNode = startSpan.firstChild;
            const endNode = endSpan.firstChild;
            if (
              startNode?.nodeType !== Node.TEXT_NODE ||
              endNode?.nodeType !== Node.TEXT_NODE
            ) {
              throw new Error(
                "Expected text-layer spans to contain text nodes",
              );
            }
            const startOffset = elementBoundaries
              ? 0
              : startSpan.textContent.indexOf(start) + startDelta;
            const endOffset = elementBoundaries
              ? endNode.textContent.length
              : endSpan.textContent.indexOf(end) + end.length + endDelta;
            if (startOffset < 0 || endOffset > endNode.textContent.length) {
              throw new Error("Selection offsets escaped their text nodes");
            }

            const range = document.createRange();
            if (elementBoundaries) {
              range.setStartBefore(startSpan);
              range.setEndAfter(endSpan);
            } else {
              range.setStart(startNode, startOffset);
              range.setEnd(endNode, endOffset);
            }
            const selection = document.getSelection();
            selection.removeAllRanges();
            if (backwards) {
              selection.setBaseAndExtent(
                endNode,
                endOffset,
                startNode,
                startOffset,
              );
            } else {
              selection.addRange(range);
            }

            const toRect = (rect) => ({
              x: rect.x,
              y: rect.y,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            });
            const rangeRects = [...range.getClientRects()].map(toRect);
            const textNodeRects = [];
            const spanRects = [];
            for (let index = startIndex; index <= endIndex; index += 1) {
              const span = spans[index];
              const node = span.firstChild;
              if (node?.nodeType !== Node.TEXT_NODE) continue;
              const from = index === startIndex ? startOffset : 0;
              const to =
                index === endIndex ? endOffset : node.textContent.length;
              if (to <= from) continue;
              const textRange = document.createRange();
              textRange.setStart(node, from);
              textRange.setEnd(node, to);
              textNodeRects.push(
                ...[...textRange.getClientRects()].map(toRect),
              );
              spanRects.push({
                text: span.textContent,
                fontSize: getComputedStyle(span).fontSize,
                rect: toRect(span.getBoundingClientRect()),
              });
            }
            const textLayerBox = textLayer.getBoundingClientRect();
            const pdfPage = await PDFViewerApplication.pdfDocument.getPage(1);
            const pdfPageView = PDFViewerApplication.pdfViewer.getPageView(0);
            const expectedQuadPoints = textNodeRects.flatMap((rect) => {
              const pdfCorners = [
                pdfPageView.getPagePoint(
                  rect.x - textLayerBox.left,
                  rect.y - textLayerBox.top,
                ),
                pdfPageView.getPagePoint(
                  rect.right - textLayerBox.left,
                  rect.y - textLayerBox.top,
                ),
                pdfPageView.getPagePoint(
                  rect.x - textLayerBox.left,
                  rect.bottom - textLayerBox.top,
                ),
                pdfPageView.getPagePoint(
                  rect.right - textLayerBox.left,
                  rect.bottom - textLayerBox.top,
                ),
              ];
              const xs = pdfCorners.map(([x]) => x);
              const ys = pdfCorners.map(([, y]) => y);
              const left = Math.min(...xs);
              const right = Math.max(...xs);
              const bottom = Math.min(...ys);
              const top = Math.max(...ys);
              return [left, top, right, top, left, bottom, right, bottom];
            });
            const selectionText = selection.toString();
            const selectionIsBackward =
              selection.anchorNode === endNode &&
              selection.anchorOffset === endOffset;
            const rangeUsesElementBoundaries =
              range.startContainer.nodeType === Node.ELEMENT_NODE &&
              range.endContainer.nodeType === Node.ELEMENT_NODE;
            const pageBox = document
              .querySelector('.page[data-page-number="1"]')
              .getBoundingClientRect();
            const pageView = pdfPage.view;
            const beforeCount = [
              ...(PDFViewerApplication.pdfDocument.annotationStorage.serializable.map?.values() ||
                []),
            ].filter(
              (annotation) =>
                annotation.annotationType === annotationType &&
                !annotation.deleted,
            ).length;
            window.dispatchEvent(
              new PointerEvent("pointerup", { button: 0, bubbles: true }),
            );
            return {
              mode,
              annotationType,
              selectionText,
              selectionIsBackward,
              rangeUsesElementBoundaries,
              startOffset,
              endOffset,
              startSpanText: startSpan.textContent,
              endSpanText: endSpan.textContent,
              rangeRects,
              textNodeRects,
              spanRects,
              expectedQuadPoints,
              pageGeometry: {
                left: pageBox.left,
                width: pageBox.width,
                center: pageBox.left + pageBox.width / 2,
                pdfWidth: pageView[2] - pageView[0],
              },
              beforeCount,
            };
          },
          {
            mode,
            annotationType,
            start,
            startDelta,
            end,
            endDelta,
            backwards,
            elementBoundaries,
          },
        );

        await viewer.waitForFunction(
          (beforeCount, annotationType) =>
            [
              ...(PDFViewerApplication.pdfDocument.annotationStorage.serializable.map?.values() ||
                []),
            ].filter(
              (annotation) =>
                annotation.annotationType === annotationType &&
                !annotation.deleted,
            ).length > beforeCount,
          {},
          geometry.beforeCount,
          annotationType,
        );
        const annotation = await viewer.evaluate((annotationType) => {
          const annotations = [
            ...(PDFViewerApplication.pdfDocument.annotationStorage.serializable.map?.values() ||
              []),
          ].filter(
            (entry) =>
              entry.annotationType === annotationType && !entry.deleted,
          );
          const entry = annotations.at(-1);
          if (!entry)
            throw new Error(
              `Annotation type ${annotationType} did not serialize`,
            );
          return {
            annotationType: entry.annotationType,
            id: entry.id,
            pageIndex: entry.pageIndex,
            rect: entry.rect ?? null,
            quadPoints: entry.quadPoints ? [...entry.quadPoints] : [],
            quadCount: entry.quadPoints ? entry.quadPoints.length / 8 : 0,
          };
        }, annotationType);
        return {
          ...geometry,
          annotation: { ...annotation, pageGeometry: geometry.pageGeometry },
        };
      };

      const selectAndCreateUnderline = (options) =>
        selectAndCreateAnnotation({ ...options, mode: 10, annotationType: 10 });

      const reopenFixture = async (openCount) => {
        setPhase(`fixture reopen before open count ${openCount}`);
        if (await viewer.evaluate(() => PDFViewerApplication._hasChanges())) {
          const expectedSave = await page.evaluate(
            () => window.__hostState.saves + 1,
          );
          await viewer.evaluate(() => PDFViewerApplication.overwriteOriginal());
          await page.waitForFunction(
            (expected) => window.__hostState.saves === expected,
            { timeout: 60_000 },
            expectedSave,
          );
          await viewer.waitForFunction(
            () =>
              !PDFViewerApplication._hasChanges() &&
              !PDFViewerApplication._saveInProgress,
            { timeout: 60_000 },
          );
        }
        const eventStart = await page.evaluate(
          () => window.__hostState.events.length,
        );
        recordLifecycle("fixture-open-dispatch-start", { openCount, eventStart });
        await page.evaluate(() => window.__reopenFixture());
        recordLifecycle("fixture-open-dispatch-complete", { openCount, eventStart });
        await waitForOpenedOrError(
          openCount,
          eventStart,
          90_000,
          "Fixture reopen",
        );
        await awaitBrowserOperation(
          "viewer.waitForSelector after fixture reopen",
          () => viewer.waitForSelector(
            '.page[data-page-number="1"] .textLayer span',
          ),
          { openCount },
        );
        await awaitBrowserOperation(
          "viewer.evaluate reset pagesRotation after fixture reopen",
          () => viewer.evaluate(() => {
            PDFViewerApplication.pdfViewer.pagesRotation = 0;
          }),
          { openCount },
        );
        await awaitBrowserOperation(
          "viewer.waitForFunction pagesRotation settled after fixture reopen",
          () => viewer.waitForFunction(() => {
            const textLayer = document.querySelector(
              '.page[data-page-number="1"] .textLayer',
            );
            return (
              PDFViewerApplication.pdfViewer.pagesRotation === 0 &&
              textLayer?.getAttribute("data-main-rotation") === "0"
            );
          }),
          { openCount },
        );
      };

      // This real page-one selection begins inside the left Abstract paragraph
      // and ends inside the right column, so every text line and both columns
      // must retain independent underline quads.
      const abstractAcrossColumns = await selectAndCreateUnderline({
        start: "Dynamic languages such as JavaScript",
        startDelta: 8,
        end: "performance.",
      });

      // The author row contains PDF text runs of 18.27px and 13.28px on the
      // same visual line (superscript affiliations), another real mixed-height
      // selection that used to create offset strokes.
      await viewer.evaluate(() => window.getSelection().removeAllRanges());
      const mixedHeightAuthorLine = await selectAndCreateUnderline({
        start: "Andreas Gal",
        end: "David Mandelin",
      });
      const abstractNestedRectPairs = findNestedRectPairs(
        abstractAcrossColumns.rangeRects,
        abstractAcrossColumns.textNodeRects,
      );
      const authorNestedRectPairs = findNestedRectPairs(
        mixedHeightAuthorLine.rangeRects,
        mixedHeightAuthorLine.textNodeRects,
      );
      const abstractRows = countTextRows(
        abstractAcrossColumns.textNodeRects,
        abstractAcrossColumns.pageGeometry.center,
      );
      const abstractQuadScreens = mapQuadsToScreen(
        abstractAcrossColumns.annotation,
      );

      await page.screenshot({
        path: path.join(artifacts, `underline-regression-${successArtifactId}.png`),
        fullPage: false,
      });
      setPhase("captured underline selections; beginning PDF save and round trip");

      const saveAndReopen = async (saveCount, openCount) => {
        setPhase(`save and reopen saved PDF before open count ${openCount}`);
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
          (expected) => window.__hostState.saves === expected,
          { timeout: 60_000 },
          saveCount,
        );
        await viewer.waitForFunction(
          () => !PDFViewerApplication._saveInProgress,
          { timeout: 60_000 },
        );
        await viewer.waitForFunction(
          () => !PDFViewerApplication._hasChanges(),
          { timeout: 60_000 },
        );
        const eventStart = await page.evaluate(
          () => window.__hostState.events.length,
        );
        recordLifecycle("saved-data-open-dispatch-start", {
          openCount,
          eventStart,
          saveCount,
        });
        await page.evaluate(() => window.__reopenSavedData());
        recordLifecycle("saved-data-open-dispatch-complete", {
          openCount,
          eventStart,
          saveCount,
        });
        await waitForOpenedOrError(
          openCount,
          eventStart,
          90_000,
          "Saved PDF reopen",
        );
        await viewer.waitForSelector(
          '.page[data-page-number="1"] .textLayer span',
        );
        return viewer.evaluate(async () => {
          const page = await PDFViewerApplication.pdfDocument.getPage(1);
          const annotations = await page.getAnnotations();
          return annotations
            .filter((annotation) => annotation.subtype === "Underline")
            .map((annotation) => ({
              subtype: annotation.subtype,
              id: annotation.id,
              rect: annotation.rect,
              quadPoints: [...annotation.quadPoints],
              hasAppearance: annotation.hasAppearance,
              quadCount: annotation.quadPoints.length / 8,
            }));
        });
      };

      const savedUnderlines = await saveAndReopen(1, 2);
      assert.equal(
        savedUnderlines.length,
        2,
        "Both real selections should save as one underline each",
      );
      assert.ok(
        savedUnderlines.every((annotation) => annotation.hasAppearance),
        "Saved underlines should have AP appearances after reopen",
      );
      assert.equal(
        savedUnderlines.reduce(
          (count, annotation) => count + annotation.quadCount,
          0,
        ),
        abstractAcrossColumns.annotation.quadCount +
          mixedHeightAuthorLine.annotation.quadCount,
        "The PDF round trip must retain every selection quad",
      );

      // Select an all-body-font paragraph using element-boundary endpoints.
      // This exercises Range.setStartBefore/setEndAfter around full text spans.
      await reopenFixture(3);
      const sameFontElementBoundary = await selectAndCreateUnderline({
        start: "Dynamic languages such as JavaScript",
        end: "programs.",
        elementBoundaries: true,
      });
      assert.equal(sameFontElementBoundary.rangeUsesElementBoundaries, true);
      assert.equal(
        new Set(
          sameFontElementBoundary.spanRects.map((entry) => entry.fontSize),
        ).size,
        1,
      );
      assert.equal(
        sameFontElementBoundary.annotation.quadCount,
        sameFontElementBoundary.textNodeRects.length,
        "Whole-span endpoints must not add element-box strokes",
      );
      assertQuadPointsMatchTextRects(
        sameFontElementBoundary,
        "same-font element-boundary selection",
      );

      // Clip both endpoints inside text nodes to cover partial text selection.
      await reopenFixture(4);
      const partialText = await selectAndCreateUnderline({
        start: "Dynamic languages such as JavaScript",
        startDelta: 8,
        end: "programs.",
        endDelta: -2,
      });
      assert.match(partialText.selectionText, /^languages/);
      assert.ok(partialText.selectionText.trimEnd().endsWith("program"));
      assert.equal(
        partialText.annotation.quadCount,
        partialText.textNodeRects.length,
      );
      assertQuadPointsMatchTextRects(
        partialText,
        "partial text-node selection",
      );

      // A backward user selection must serialize the same geometry as the
      // forward selection of the same text.
      await reopenFixture(5);
      const reverseSelection = await selectAndCreateUnderline({
        start: "Dynamic languages such as JavaScript",
        end: "programs.",
        backwards: true,
      });
      assert.equal(reverseSelection.selectionIsBackward, true);
      assert.deepEqual(
        normalizeQuadPoints(reverseSelection.annotation.quadPoints),
        normalizeQuadPoints(sameFontElementBoundary.annotation.quadPoints),
        "Selection direction must not reorder or duplicate underline geometry",
      );
      assertQuadPointsMatchTextRects(reverseSelection, "backward selection");

      const rotationScenarios = [
        {
          rotation: 0,
          quadCount: partialText.annotation.quadCount,
          textRectCount: partialText.textNodeRects.length,
        },
      ];
      let nextOpenCount = 6;
      for (const rotation of [90, 180, 270]) {
        await reopenFixture(nextOpenCount);
        nextOpenCount += 1;
        await viewer.evaluate((value) => {
          PDFViewerApplication.pdfViewer.pagesRotation = value;
        }, rotation);
        await viewer.waitForFunction(
          (value) => {
            const textLayer = document.querySelector(
              '.page[data-page-number="1"] .textLayer',
            );
            return (
              PDFViewerApplication.pdfViewer.pagesRotation === value &&
              textLayer?.getAttribute("data-main-rotation") === String(value)
            );
          },
          {},
          rotation,
        );
        const rotatedSelection = await selectAndCreateUnderline({
          start: "Dynamic languages such as JavaScript",
          startDelta: 8,
          end: "programs.",
          endDelta: -2,
        });
        assert.equal(
          rotatedSelection.annotation.quadCount,
          rotatedSelection.textNodeRects.length,
        );
        assertQuadPointsMatchTextRects(
          rotatedSelection,
          `${rotation}-degree selection`,
        );
        rotationScenarios.push({
          rotation,
          quadCount: rotatedSelection.annotation.quadCount,
          textRectCount: rotatedSelection.textNodeRects.length,
        });
      }

      // Highlight intentionally keeps the pre-existing full Range geometry.
      // This guards the fix to the Underline path only.
      await reopenFixture(9);
      const highlightSelection = await selectAndCreateAnnotation({
        mode: 9,
        annotationType: 9,
        start: "Dynamic languages such as JavaScript",
        startDelta: 8,
        end: "performance.",
      });
      const positiveRangeRects = highlightSelection.rangeRects.filter(
        (rect) => rect.width > 0 && rect.height > 0,
      );
      assert.equal(
        highlightSelection.annotation.quadCount,
        positiveRangeRects.length,
      );

      const savedBase64 = await page.evaluate(() => {
        const bytes = new Uint8Array(window.__hostState.savedData);
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(
            ...bytes.subarray(offset, offset + 0x8000),
          );
        }
        return btoa(binary);
      });
      await writeFile(
        path.join(artifacts, `underline-regression-${successArtifactId}.pdf`),
        Buffer.from(savedBase64, "base64"),
      );
      const diagnostics = {
        captureId,
        runId,
        payloadId: payload.id,
        contentHash: payload.contentHash,
        initialText: initial.text,
        abstractAcrossColumns,
        mixedHeightAuthorLine,
        sameFontElementBoundary,
        partialText,
        reverseSelection,
        rotationScenarios,
        highlightSelection,
        abstractNestedRectPairs,
        authorNestedRectPairs,
        abstractRows,
        abstractQuadScreens,
        savedUnderlines,
        apiRequestCount,
        externalRequests,
        pageErrors,
        consoleErrors,
      };
      await writeFile(
        path.join(artifacts, `underline-regression-${successArtifactId}.json`),
        JSON.stringify(diagnostics, null, 2),
        "utf8",
      );

      // A pair of separately saved selections must never be joined across
      // columns or collapse to a single line. Source and serialized geometry
      // are retained above so failures show the exact browser and PDF quads.
      assert.ok(
        abstractAcrossColumns.rangeRects.length > 8,
        "The Abstract selection should span multiple lines in both columns",
      );
      assert.ok(
        abstractNestedRectPairs.length > 0,
        "The browser Range should expose nested span/text rectangles in the baseline fixture",
      );
      assert.ok(
        authorNestedRectPairs.length > 0,
        "Mixed-size author text should expose nested span/text rectangles",
      );
      assert.ok(
        abstractRows.length > 8,
        "The selected text should cover many distinct line rows",
      );
      assert.ok(
        abstractAcrossColumns.annotation.quadCount >= abstractRows.length,
        "Adjacent selected lines must remain distinct underline quads",
      );
      assert.ok(abstractQuadScreens.some((rect) => rect.right < rect.center));
      assert.ok(abstractQuadScreens.some((rect) => rect.left > rect.center));
      assert.ok(
        abstractQuadScreens.every(
          (rect) => rect.right < rect.center || rect.left > rect.center,
        ),
        "No serialized underline quad may connect the two text columns",
      );
      assert.ok(
        mixedHeightAuthorLine.spanRects.some(
          (entry) => Number.parseFloat(entry.fontSize) < 15,
        ),
      );
      assert.ok(
        mixedHeightAuthorLine.spanRects.some(
          (entry) => Number.parseFloat(entry.fontSize) > 17,
        ),
      );
      assert.equal(
        abstractAcrossColumns.annotation.quadCount,
        abstractAcrossColumns.textNodeRects.length,
        "Underline quads must follow clipped text-node rects, not nested Range element boxes",
      );
      assert.equal(
        mixedHeightAuthorLine.annotation.quadCount,
        mixedHeightAuthorLine.textNodeRects.length,
        "Mixed-height runs must not add a second underline for their span bounding boxes",
      );
      assertQuadPointsMatchTextRects(
        abstractAcrossColumns,
        "cross-column Abstract selection",
      );
      assertQuadPointsMatchTextRects(
        mixedHeightAuthorLine,
        "mixed-height author row",
      );
      assert.equal(
        apiRequestCount,
        0,
        "The offline viewer must not call a PDF.js API service",
      );
      assert.deepEqual(
        externalRequests,
        [],
        "The browser must not request external resources",
      );
      assert.deepEqual(pageErrors, []);
      if (process.env.PDF_READER_OPEN_TRACE === "1") {
        const openTrace = await viewer.evaluate(() => {
          const trace = window.__underlinePdfOpenTrace;
          const snapshot = trace?.snapshot?.() ?? null;
          trace?.stop?.();
          return { install: window.__underlinePdfOpenTraceInstallResult ?? null, snapshot };
        });
        const openTracePath = path.join(
          artifacts,
          `underline-open-trace-${captureId}-${Date.now()}.json`,
        );
        await writeFile(
          openTracePath,
          JSON.stringify(
            {
              captureId,
              payloadId: payload.id,
              contentHash: payload.contentHash,
              phase,
              openTraceInstall,
              ...openTrace,
            },
            null,
            2,
          ),
        );
        console.log(`Underline open trace captured in ${openTracePath}`);
      }
      console.log(
        `Underline geometry and PDF round-trip captured in tests/artifacts/underline-regression-${successArtifactId}.{json,png,pdf}`,
      );
    } catch (error) {
      primaryError = error;
      const captureErrors = [];
      const failureId = `${captureId}-${runId}`;
      failureDiagnosticsPath = path.join(
        artifacts,
        `underline-regression-${failureId}-failure.json`,
      );
      const failurePngPath = path.join(
        artifacts,
        `underline-regression-${failureId}-failure.png`,
      );
      const diagnostics = {
        captureId,
        failureId,
        ...(diagnosticsEnabled ? { runId } : {}),
        createdAt: new Date().toISOString(),
        payloadId: payload.id,
        contentHash: payload.contentHash,
        phase,
        activeOperation,
        testAbort: {
          aborted: testSignal.aborted,
          reason: testSignal.aborted
            ? String(testSignal.reason?.message ?? testSignal.reason ?? "").slice(0, 300)
            : null,
        },
        ...(diagnosticsEnabled
          ? { phaseHistory, lifecycleTrace, cdpWorkerTrace }
          : {}),
        failure: {
          name: error?.name ?? typeof error,
          message: error?.message ?? String(error),
          stack: error?.stack ?? null,
        },
        browser: (() => {
          const child = browser?.process?.();
          return {
            connected: browserConnected(),
            pid: child?.pid ?? null,
            exitCode: child?.exitCode ?? null,
            signalCode: child?.signalCode ?? null,
          };
        })(),
        serverListening: server?.listening ?? null,
        pageErrors,
        consoleErrors,
        externalRequests,
        apiRequestCount,
      };
      if (testSignal.aborted) {
        captureErrors.push(
          "Page snapshots omitted because the Node test abort already started bounded browser cleanup.",
        );
      } else if (page && !page.isClosed()) {
        const pageSnapshot = await settleWithin(
          page.evaluate(() => {
            const state = window.__hostState;
            return {
              url: location.href,
              state: state
                ? {
                    opened: state.opened,
                    saves: state.saves,
                    harnessError: state.error ?? null,
                    savedDataByteLength: state.savedDataByteLength,
                    openRequests: state.openRequests,
                    events: state.events,
                    errors: state.errors,
                  }
                : null,
            };
          }),
          3_000,
        );
        if (pageSnapshot.value) {
          diagnostics.page = pageSnapshot.value;
        } else {
          captureErrors.push(
            `Could not capture host state: ${pageSnapshot.error?.message || "page evaluation timed out"}`,
          );
        }
        try {
          await settleWithin(
            page.screenshot({ path: failurePngPath, fullPage: false }),
            5_000,
          ).then((result) => {
            if (result.timedOut) {
              throw new Error("Failure screenshot timed out after 5000ms.");
            }
            if (result.error) throw result.error;
          });
          diagnostics.failureScreenshot = failurePngPath;
        } catch (captureError) {
          captureErrors.push(
            `Could not capture failure screenshot: ${captureError?.message || captureError}`,
          );
        }
      }
      if (!testSignal.aborted && viewer && !viewer.isDetached()) {
        const viewerSnapshot = await settleWithin(
          viewer.evaluate(() => {
            const app = window.PDFViewerApplication;
            const pdfDocument = app?.pdfDocument;
            return {
              url: location.href,
              appReady: !!app,
              pdfDocument: pdfDocument
                ? {
                    numPages: pdfDocument.numPages,
                    fingerprints: pdfDocument.fingerprints,
                  }
                : null,
              saveInProgress: app?._saveInProgress ?? null,
              hasChanges: app?._hasChanges?.() ?? null,
              annotationMode:
                app?.pdfViewer?.annotationEditorMode ?? null,
              loadedPages: [...window.document.querySelectorAll(".page")].map(
                (page) => page.dataset.pageNumber,
              ),
              textLayerSpanCount: window.document.querySelectorAll(
                '.page[data-page-number="1"] .textLayer span',
              ).length,
              openTraceInstall: window.__underlinePdfOpenTraceInstallResult ?? null,
              openTrace: (() => {
                const trace = window.__underlinePdfOpenTrace;
                const snapshot = trace?.snapshot?.() ?? null;
                trace?.stop?.();
                return snapshot;
              })(),
            };
          }),
          3_000,
        );
        if (viewerSnapshot.value) {
          diagnostics.viewer = viewerSnapshot.value;
        } else {
          captureErrors.push(
            `Could not capture viewer state: ${viewerSnapshot.error?.message || "frame evaluation timed out"}`,
          );
        }
      }
      diagnostics.captureErrors = captureErrors;
      try {
        if (diagnosticsEnabled) failureDiagnostics = diagnostics;
        await writeFile(
          failureDiagnosticsPath,
          JSON.stringify(diagnostics, null, 2),
        );
        const details = [
          `Underline failure diagnostics: ${failureDiagnosticsPath}`,
        ];
        if (diagnostics.failureScreenshot) {
          details.push(`Underline failure screenshot: ${failurePngPath}`);
        }
        if (captureErrors.length) {
          details.push(`Diagnostic capture issues: ${captureErrors.join("; ")}`);
        }
        appendErrorDetails(error, details.join("\n"));
      } catch (captureError) {
        appendErrorDetails(
          error,
          `Could not write underline failure diagnostics: ${captureError?.message || captureError}`,
        );
      }
    } finally {
      try {
        cleanupReport = await startBrowserCleanup(
          testSignal.aborted ? "node-test-abort-finally" : "test-finally",
        );
      } catch (error) {
        cleanupReport = {
          status: "failed",
          browser: null,
          server: null,
          errors: [{
            phase: "cleanup.helper",
            name: error?.name || "Error",
            message: error?.message || String(error),
            stack: error?.stack || null,
          }],
        };
      }
      testSignal.removeEventListener("abort", onTestAbort);
      restoreCDPSend?.();
      restoreCDPOnMessage?.();
      recordLifecycle("cdp-worker-trace-restored");
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
      if (cleanupReport.errors.length && cleanupReport.status === "normal") {
        cleanupReport.status = "failed";
      }
      if (cleanupReport.status !== "normal") {
        const fallbackId = `${captureId}-${runId}`;
        const fallbackJsonPath = path.join(
          artifacts,
          `underline-regression-${fallbackId}-cleanup.json`,
        );
        try {
          await writeFile(
            fallbackJsonPath,
            JSON.stringify({
              captureId,
              fallbackId,
              payloadId: payload.id,
              contentHash: payload.contentHash,
              ...(diagnosticsEnabled ? { runId } : {}),
              createdAt: new Date().toISOString(),
              ...(diagnosticsEnabled
                ? { phase, phaseHistory, lifecycleTrace, cdpWorkerTrace }
                : {}),
              primaryError: primaryError
                ? {
                    name: primaryError.name || "Error",
                    message: primaryError.message || String(primaryError),
                  }
                : null,
              ...cleanupReport,
            }, null, 2),
          );
          console.log(`Underline browser cleanup report captured in ${fallbackJsonPath}`);
        } catch (error) {
          cleanupReport.errors.push({
            phase: "cleanup-report.write",
            name: error?.name || "Error",
            message: error?.message || String(error),
            stack: error?.stack || null,
          });
          cleanupReport.status = "failed";
        }
      }
      if (failureDiagnostics && failureDiagnosticsPath) {
        failureDiagnostics.cleanupReport = cleanupReport;
        failureDiagnostics.phaseHistory = phaseHistory;
        failureDiagnostics.lifecycleTrace = lifecycleTrace;
        failureDiagnostics.cdpWorkerTrace = cdpWorkerTrace;
        try {
          await writeFile(
            failureDiagnosticsPath,
            JSON.stringify(failureDiagnostics, null, 2),
          );
        } catch (error) {
          cleanupReport.errors.push({
            phase: "failure-diagnostics.finalize",
            name: error?.name || "Error",
            message: error?.message || String(error),
            stack: error?.stack || null,
          });
          cleanupReport.status = "failed";
        }
      }
      if (diagnosticsEnabled) {
        const tracePath = path.join(
          artifacts,
          `underline-cdp-trace-${captureId}-${runId}.json`,
        );
        try {
          await writeFile(
            tracePath,
            JSON.stringify(
              {
                captureId,
                runId,
                payloadId: payload.id,
                contentHash: payload.contentHash,
                browserPath,
                startedAt: runStartedAt,
                finishedAt: Date.now(),
                phase,
                phaseHistory,
                lifecycleTrace,
                cdpWorkerTrace,
                cleanupReport,
                failure: primaryError
                  ? {
                      name: primaryError.name || "Error",
                      message: String(
                        primaryError.message || primaryError,
                      ).slice(0, 1_000),
                    }
                  : null,
              },
              null,
              2,
            ),
          );
          console.log(`Underline lifecycle/CDP trace captured in ${tracePath}`);
        } catch (error) {
          cleanupReport.errors.push({
            phase: "cdp-trace.write",
            name: error?.name || "Error",
            message: error?.message || String(error),
            stack: error?.stack || null,
          });
          cleanupReport.status = "failed";
          const fallbackId = `${captureId}-${runId}`;
          const fallbackJsonPath = path.join(
            artifacts,
            `underline-regression-${fallbackId}-cleanup.json`,
          );
          try {
            await writeFile(
              fallbackJsonPath,
              JSON.stringify({
                captureId,
                fallbackId,
                payloadId: payload.id,
                contentHash: payload.contentHash,
                ...(diagnosticsEnabled ? { runId } : {}),
                createdAt: new Date().toISOString(),
                phase,
                primaryError: primaryError
                  ? {
                      name: primaryError.name || "Error",
                      message: primaryError.message || String(primaryError),
                    }
                  : null,
                ...cleanupReport,
              }, null, 2),
            );
            console.log(
              `Underline browser cleanup report captured in ${fallbackJsonPath}`,
            );
          } catch (sidecarError) {
            cleanupReport.errors.push({
              phase: "cleanup-report.write-after-trace-failure",
              name: sidecarError?.name || "Error",
              message: sidecarError?.message || String(sidecarError),
              stack: sidecarError?.stack || null,
            });
            cleanupReport.status = "failed";
          }
        }
      }
    }
    const finalError = attachCleanupErrors(primaryError, cleanupReport);
    if (finalError) throw finalError;
  },
);
