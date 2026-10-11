import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import test from "node:test";
import {
  computePayloadHash, createDiskAdapter, createTempRoot, loadBundledPlugin,
  readBuiltMain, removeTempRoot, replacePayloadInMain,
} from "./bundled-plugin-test-utils.mjs";

function makePayload() {
  const paths = ["web/viewer.html", "web/viewer.css", "web/bridge.css",
    "web/obsidian-bridge.js", "build/pdf.mjs", "web/viewer.mjs", "build/pdf.worker.mjs"];
  const files = paths.map((path) => {
    const bytes = Buffer.from(`verified startup fixture ${path}`);
    return { path, size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      gzipBase64: gzipSync(bytes).toString("base64") };
  });
  const payload = { schema: 1, id: "startup-fixture-v1", files };
  payload.contentHash = computePayloadHash(payload);
  return payload;
}

function scheduler() {
  let sequence = 0;
  const timers = new Map();
  return {
    timers,
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    runNext() {
      const [id, entry] = timers.entries().next().value || [];
      assert.ok(entry, "An actual prewarm timer must be scheduled");
      timers.delete(id); entry.callback(); return entry.delay;
    },
  };
}

function eventTarget(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    dispatch(name) { for (const listener of listeners.get(name) || []) listener(); },
  };
}

async function fixture(adapterOptions = {}) {
  const temp = await createTempRoot("startup-prewarm-");
  const adapter = createDiskAdapter(temp, adapterOptions);
  const clock = scheduler();
  const window = eventTarget();
  const document = eventTarget({ visibilityState: "visible" });
  const payload = makePayload();
  const harness = loadBundledPlugin(
    replacePayloadInMain(await readBuiltMain(), payload), adapter, null,
    { browserGlobals: { window, document,
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout } },
  );
  harness.app.isMobile = true;
  const domListeners = [];
  harness.plugin.registerDomEvent = (target, name, listener) => {
    target.addEventListener(name, listener); domListeners.push({ target, name, listener });
  };
  let layoutCallback;
  harness.app.workspace.layoutReady = false;
  harness.app.workspace.onLayoutReady = (callback) => { layoutCallback = callback; };
  let createdLeaves = 0;
  harness.app.workspace.getLeaf = () => { createdLeaves++; throw Error("Prewarm must not materialize a Reader"); };
  return {
    ...harness, temp, adapter, clock, window, document, payload,
    get createdLeaves() { return createdLeaves; },
    layoutReady() { harness.app.workspace.layoutReady = true; layoutCallback(); },
    async runNext() { const delay = clock.runNext(); const result = await harness.plugin.prewarmPromise; return { delay, result }; },
    async close() {
      harness.plugin.onunload();
      for (const { target, name, listener } of domListeners) target.removeEventListener(name, listener);
      await removeTempRoot(temp);
    },
  };
}

test("mobile prewarm starts without layout readiness or an opened Reader, then reuses prepared bytes", async () => {
  const f = await fixture();
  try {
    await f.load();
    assert.equal(f.plugin.resourcePrewarm.status, "scheduled");
    assert.equal(f.clock.timers.size, 1);
    const { result } = await f.runNext();
    assert.ok(result);
    assert.equal(f.app.workspace.layoutReady, false);
    assert.equal(f.createdLeaves, 0);
    assert.equal(f.plugin.views.size, 0);
    assert.equal(f.plugin.resourcePrewarm.status, "ready");
    assert.equal(f.plugin.resourcePrewarm.reason, "plugin-load");
    assert.equal(f.plugin.verifiedAssetBytes.size, 7);
    assert.equal(f.adapter.writeCount, 7);
    f.layoutReady(); f.window.dispatch("focus"); f.document.dispatch("visibilitychange");
    assert.equal(f.clock.timers.size, 0, "Later layout/foreground callbacks must not repeat successful prewarm");
    const assets = await f.plugin.ensureViewerAssets();
    assert.equal(assets.metrics.checkedFiles, 0);
    assert.equal(assets.metrics.verificationReads, 0);
    assert.equal(assets.metrics.decodedFiles, 0);
  } finally { await f.close(); }
});

test("opening during background preparation shares the initialization task", async () => {
  const f = await fixture();
  let entered;
  const arrival = new Promise((resolve) => { entered = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const originalRead = f.adapter.readBinary;
  let paused = false;
  f.adapter.readBinary = async (path) => {
    if (!paused) { paused = true; entered(); await gate; }
    return originalRead(path);
  };
  try {
    await f.load(); f.clock.runNext();
    const prewarm = f.plugin.prewarmPromise;
    await arrival;
    const opening = f.plugin.ensureViewerAssets();
    assert.equal(opening, f.plugin.viewerAssetsPromise);
    release();
    await Promise.all([prewarm, opening]);
    assert.equal(f.plugin.resourcePrewarm.status, "ready");
    assert.equal(f.adapter.writeCount, f.payload.files.length);
    assert.equal(f.createdLeaves, 0);
  } finally { release(); await f.close(); }
});

test("a failed prewarm records its failure and retries without requiring a PDF click", async () => {
  const f = await fixture({ failWrite: (_path, count) => count === 1 });
  try {
    await f.load();
    const first = await f.runNext();
    assert.equal(first.result, null);
    assert.equal(f.plugin.resourcePrewarm.attempts, 1);
    assert.equal(f.plugin.resourcePrewarm.lastErrorCode, "asset-prewarm-failed");
    const second = await f.runNext();
    assert.equal(second.delay, 1000);
    assert.ok(second.result);
    assert.equal(f.plugin.resourcePrewarm.status, "ready");
    assert.equal(f.plugin.resourcePrewarm.attempts, 2);
    assert.equal(f.plugin.resourcePrewarm.lastErrorCode, null);
    assert.equal(f.createdLeaves, 0);
  } finally { await f.close(); }
});

test("prewarm retries are bounded, foreground can retry, and unload cancels pending startup", async () => {
  let fail = true;
  const f = await fixture({ failWrite: () => fail });
  try {
    await f.load();
    await f.runNext(); await f.runNext(); await f.runNext();
    assert.equal(f.plugin.resourcePrewarm.status, "failed");
    assert.equal(f.plugin.resourcePrewarm.attempts, 3);
    assert.equal(f.clock.timers.size, 0);
    fail = false;
    f.window.dispatch("focus");
    await f.runNext();
    assert.equal(f.plugin.resourcePrewarm.status, "ready");
    assert.equal(f.plugin.resourcePrewarm.attempts, 1);
    f.plugin.invalidateViewerAssets();
    f.plugin.scheduleViewerPrewarm("foreground");
    assert.equal(f.clock.timers.size, 1);
    f.plugin.onunload(); f.layoutReady(); f.window.dispatch("focus");
    assert.equal(f.clock.timers.size, 0);
    assert.equal(f.plugin.resourcePrewarm.status, "disposed");
  } finally { await f.close(); }
});
