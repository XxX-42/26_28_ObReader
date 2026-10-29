import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const { computeContentHash, ensureViewerAssets } = require(
  "../plugin/asset-runtime.cjs",
);
const pluginRoot = ".obsidian/plugins/pdf-web-reader";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function makePayload(count = 5) {
  const files = Array.from({ length: count }, (_, index) => {
    const bytes = Buffer.from(`viewer-asset-${index}`);
    return {
      path: `web/asset-${index}.bin`,
      size: bytes.byteLength,
      sha256: sha256(bytes),
      gzipBase64: gzipSync(bytes).toString("base64"),
    };
  });
  const payload = { schema: 1, id: "stat-index-v1", files };
  payload.contentHash = computeContentHash(payload);
  return payload;
}

function createState() {
  return { entries: new Map(), directories: new Set(), clock: 100 };
}

function createStatAdapter(
  state,
  { onRead = null, onStat = null, statEnabled = true } = {},
) {
  const binaryReads = [];
  const binaryWrites = [];
  const statReads = [];
  const adapter = {
    binaryReads,
    binaryWrites,
    statReads,
    state,
    async exists(path) {
      return state.entries.has(path) || state.directories.has(path);
    },
    async mkdir(path) {
      state.directories.add(path);
    },
    async readBinary(path) {
      binaryReads.push(path);
      const entry = state.entries.get(path);
      if (!entry?.bytes) throw new Error(`Missing binary file: ${path}`);
      const captured = new Uint8Array(entry.bytes);
      await onRead?.(path, captured);
      return captured.buffer;
    },
    async writeBinary(path, value) {
      const bytes = new Uint8Array(value);
      binaryWrites.push(path);
      state.clock += 1;
      state.entries.set(path, {
        bytes: new Uint8Array(bytes),
        mtime: state.clock,
        ctime: state.clock,
      });
    },
    async remove(path) {
      state.entries.delete(path);
    },
    async read(path) {
      const entry = state.entries.get(path);
      if (typeof entry?.text !== "string") throw new Error(`Missing text file: ${path}`);
      return entry.text;
    },
    async write(path, text) {
      state.clock += 1;
      state.entries.set(path, {
        text,
        mtime: state.clock,
        ctime: state.clock,
      });
    },
  };
  if (statEnabled) {
    adapter.stat = async (path) => {
      statReads.push(path);
      const entry = state.entries.get(path);
      if (!entry?.bytes) return null;
      const result = {
        type: "file",
        size: entry.bytes.byteLength,
        mtime: entry.mtime,
        ctime: entry.ctime,
      };
      await onStat?.(path, result);
      return result;
    };
  }
  return adapter;
}

function storedMarker(state, result) {
  return state.entries.get(`${result.rootPath}/.complete.json`);
}

function countReadsFor(adapter, path) {
  return adapter.binaryReads.filter((read) => read === path).length;
}

test("a fresh adapter uses the persistent index for a zero-binary-read warm restart", async () => {
  const state = createState();
  const payload = makePayload();
  const firstAdapter = createStatAdapter(state);
  const first = await ensureViewerAssets(firstAdapter, pluginRoot, payload);
  assert.equal(first.metrics.cacheHit, false);
  assert.equal(first.metrics.statChecks, payload.files.length * 3,
    "an absent cache root needs no per-file missing stat; readback remains bracketed and rechecked");

  const marker = JSON.parse(storedMarker(state, first).text);
  assert.equal(marker.statIndexVersion, 1);
  assert.equal(marker.statIndex.length, payload.files.length);
  assert.deepEqual(
    marker.statIndex.map(({ path }) => path),
    [...payload.files.map(({ path }) => path)].sort(),
  );

  const restartedAdapter = createStatAdapter(state);
  const restarted = await ensureViewerAssets(restartedAdapter, pluginRoot, payload);
  assert.equal(restarted.metrics.cacheHit, true);
  assert.equal(restarted.metrics.statCacheFiles, payload.files.length);
  assert.equal(restarted.metrics.verificationReads, 0);
  assert.deepEqual(restartedAdapter.binaryReads, []);
  assert.equal(restartedAdapter.binaryWrites.length, 0);
});

test("same-size content changes with new mtime/ctime repair only that cached asset", async () => {
  const state = createState();
  const payload = makePayload(6);
  const first = await ensureViewerAssets(
    createStatAdapter(state),
    pluginRoot,
    payload,
  );
  const changedFile = payload.files[3];
  const changedPath = `${first.rootPath}/${changedFile.path}`;
  const original = state.entries.get(changedPath).bytes;
  const changedBytes = new Uint8Array(original.length).fill(0x78);
  assert.notDeepEqual(changedBytes, original);
  state.clock += 1;
  state.entries.set(changedPath, {
    bytes: changedBytes,
    mtime: state.clock,
    ctime: state.clock,
  });

  const restartedAdapter = createStatAdapter(state);
  const repaired = await ensureViewerAssets(restartedAdapter, pluginRoot, payload);
  assert.equal(repaired.metrics.cacheHit, false);
  assert.equal(repaired.metrics.decodedFiles, 1);
  assert.equal(repaired.metrics.repairedFiles, 1);
  assert.equal(restartedAdapter.binaryWrites.length, 1);
  assert.equal(restartedAdapter.binaryWrites[0], changedPath);
  assert.equal(countReadsFor(restartedAdapter, changedPath), 2);
  assert.equal(
    restartedAdapter.binaryReads.filter((path) => path !== changedPath).length,
    0,
    "unchanged cached assets are verified from their stat rows",
  );
  assert.equal(
    Buffer.from(state.entries.get(changedPath).bytes).toString(),
    "viewer-asset-3",
  );
});

test("a metadata-only touch is hashed once and refreshes its stat row without rewriting bytes", async () => {
  const state = createState();
  const payload = makePayload(4);
  const first = await ensureViewerAssets(
    createStatAdapter(state),
    pluginRoot,
    payload,
  );
  const file = payload.files[1];
  const path = `${first.rootPath}/${file.path}`;
  const before = state.entries.get(path);
  state.clock += 10;
  state.entries.set(path, {
    bytes: new Uint8Array(before.bytes),
    mtime: state.clock,
    ctime: before.ctime,
  });

  const adapter = createStatAdapter(state);
  const refreshed = await ensureViewerAssets(adapter, pluginRoot, payload);
  assert.equal(refreshed.metrics.cacheHit, false);
  assert.equal(refreshed.metrics.repairedFiles, 0);
  assert.equal(refreshed.metrics.decodedFiles, 0);
  assert.deepEqual(adapter.binaryReads, [path]);
  assert.deepEqual(adapter.binaryWrites, []);
  const newMarker = JSON.parse(storedMarker(state, refreshed).text);
  const row = newMarker.statIndex.find((entry) => entry.path === file.path);
  assert.equal(row.mtime, state.entries.get(path).mtime);
  assert.equal(row.ctime, state.entries.get(path).ctime);

  const nextAdapter = createStatAdapter(state);
  const next = await ensureViewerAssets(nextAdapter, pluginRoot, payload);
  assert.equal(next.metrics.cacheHit, true);
  assert.deepEqual(nextAdapter.binaryReads, []);
});

test("a missing cached asset is repaired without rereading unchanged assets", async () => {
  const state = createState();
  const payload = makePayload(5);
  const first = await ensureViewerAssets(
    createStatAdapter(state),
    pluginRoot,
    payload,
  );
  const missingPath = `${first.rootPath}/${payload.files[2].path}`;
  state.entries.delete(missingPath);

  const adapter = createStatAdapter(state);
  const repaired = await ensureViewerAssets(adapter, pluginRoot, payload);
  assert.equal(repaired.metrics.repairedFiles, 1);
  assert.deepEqual(adapter.binaryWrites, [missingPath]);
  assert.equal(countReadsFor(adapter, missingPath), 1);
  assert.equal(
    adapter.binaryReads.filter((path) => path !== missingPath).length,
    0,
  );
});

test("legacy and malformed stat indexes migrate through full SHA verification", async (t) => {
  for (const variant of ["legacy", "malformed"]) {
    await t.test(variant, async () => {
      const state = createState();
      const payload = makePayload(4);
      const first = await ensureViewerAssets(
        createStatAdapter(state),
        pluginRoot,
        payload,
      );
      const markerPath = `${first.rootPath}/.complete.json`;
      const marker = JSON.parse(state.entries.get(markerPath).text);
      if (variant === "legacy") {
        delete marker.statIndexVersion;
        delete marker.statIndex;
      } else {
        marker.statIndex[1].path = "web/untrusted.bin";
      }
      await createStatAdapter(state).write(markerPath, JSON.stringify(marker));

      const adapter = createStatAdapter(state);
      const migrated = await ensureViewerAssets(adapter, pluginRoot, payload);
      assert.equal(migrated.metrics.cacheHit, false);
      assert.equal(adapter.binaryReads.length, payload.files.length);
      assert.deepEqual(adapter.binaryWrites, []);
      const repairedMarker = JSON.parse(storedMarker(state, migrated).text);
      assert.equal(repairedMarker.statIndexVersion, 1);
      assert.equal(repairedMarker.statIndex.length, payload.files.length);
    });
  }
});

test("forceVerify performs a full content scan, including same-stat mutations", async () => {
  const state = createState();
  const payload = makePayload(5);
  const first = await ensureViewerAssets(
    createStatAdapter(state),
    pluginRoot,
    payload,
  );
  const file = payload.files[0];
  const path = `${first.rootPath}/${file.path}`;
  const prior = state.entries.get(path);
  state.entries.set(path, {
    bytes: new Uint8Array(prior.bytes.length).fill(0x7a),
    mtime: prior.mtime,
    ctime: prior.ctime,
  });

  const adapter = createStatAdapter(state);
  const forced = await ensureViewerAssets(adapter, pluginRoot, payload, {
    forceVerify: true,
  });
  assert.equal(forced.metrics.cacheHit, false);
  assert.equal(forced.metrics.repairedFiles, 1);
  assert.equal(adapter.binaryReads.length, payload.files.length + 1);
  assert.equal(adapter.binaryWrites.length, 1);
  assert.equal(adapter.binaryWrites[0], path);
  assert.equal(Buffer.from(state.entries.get(path).bytes).toString(), "viewer-asset-0");
});

test("forceVerify waits for an in-flight initialization before starting a full scan", async () => {
  const state = createState();
  const payload = makePayload(5);
  await ensureViewerAssets(createStatAdapter(state), pluginRoot, payload);
  const changedPath = `${pluginRoot}/.asset-cache/${payload.id}/${payload.contentHash}/${payload.files[1].path}`;
  const prior = state.entries.get(changedPath);
  state.entries.set(changedPath, {
    bytes: new Uint8Array(prior.bytes.length).fill(0x7b),
    mtime: prior.mtime,
    ctime: prior.ctime,
  });

  let releaseStat;
  let notifyEntered;
  const blocked = new Promise((resolve) => { releaseStat = resolve; });
  const entered = new Promise((resolve) => { notifyEntered = resolve; });
  let didBlock = false;
  const adapter = createStatAdapter(state, {
    async onStat(path) {
      if (path !== changedPath || didBlock) return;
      didBlock = true;
      notifyEntered();
      await blocked;
    },
  });

  const normal = ensureViewerAssets(adapter, pluginRoot, payload);
  await entered;
  const forced = ensureViewerAssets(adapter, pluginRoot, payload, {
    forceVerify: true,
  });
  releaseStat();
  const normalResult = await normal;
  const forcedResult = await forced;
  assert.equal(normalResult.metrics.cacheHit, true);
  assert.equal(normalResult.metrics.verificationReads, 0);
  assert.equal(forcedResult.metrics.repairedFiles, 1);
  assert.equal(adapter.binaryReads.length, payload.files.length + 1);
  assert.equal(adapter.binaryWrites.length, 1);
  assert.equal(Buffer.from(state.entries.get(changedPath).bytes).toString(), "viewer-asset-1");
});

test("stat-unavailable adapters fall back to full SHA checks on each restart", async () => {
  const state = createState();
  const payload = makePayload(4);
  const firstAdapter = createStatAdapter(state, { statEnabled: false });
  const first = await ensureViewerAssets(firstAdapter, pluginRoot, payload);
  const restartedAdapter = createStatAdapter(state, { statEnabled: false });
  const restarted = await ensureViewerAssets(restartedAdapter, pluginRoot, payload);
  assert.equal(restarted.metrics.cacheHit, true);
  assert.equal(restarted.metrics.verificationReads, payload.files.length);
  assert.equal(restartedAdapter.binaryReads.length, payload.files.length);
  assert.deepEqual(restartedAdapter.binaryWrites, []);
  assert.equal(JSON.parse(storedMarker(state, first).text).statIndex.length, 4);
});

test("a one-sided stat failure uses SHA and leaves a null index row", async () => {
  const state = createState();
  const payload = makePayload(4);
  const first = await ensureViewerAssets(
    createStatAdapter(state),
    pluginRoot,
    payload,
  );
  const file = payload.files[1];
  const path = `${first.rootPath}/${file.path}`;
  const entry = state.entries.get(path);
  state.clock += 1;
  state.entries.set(path, { ...entry, mtime: state.clock });

  let targetStatCalls = 0;
  const adapter = createStatAdapter(state);
  const stat = adapter.stat.bind(adapter);
  adapter.stat = async (candidate) => {
    if (candidate === path && ++targetStatCalls > 1) return null;
    return stat(candidate);
  };
  const result = await ensureViewerAssets(adapter, pluginRoot, payload);

  assert.equal(targetStatCalls, 3);
  assert.equal(result.metrics.verificationReads, 1);
  assert.equal(result.metrics.repairedFiles, 0);
  assert.deepEqual(adapter.binaryWrites, []);
  const marker = JSON.parse(storedMarker(state, result).text);
  assert.equal(
    marker.statIndex.find((row) => row.path === file.path).mtime,
    null,
  );
});

test("zero mtime is unusable while a zero ctime with positive mtime remains usable", async (t) => {
  await t.test("zero ctime", async () => {
    const state = createState();
    const payload = makePayload(3);
    const firstAdapter = createStatAdapter(state);
    const firstStat = firstAdapter.stat.bind(firstAdapter);
    firstAdapter.stat = async (path) => {
      const value = await firstStat(path);
      return value ? { ...value, ctime: 0 } : value;
    };
    const first = await ensureViewerAssets(firstAdapter, pluginRoot, payload);

    const restartedAdapter = createStatAdapter(state);
    const restartStat = restartedAdapter.stat.bind(restartedAdapter);
    restartedAdapter.stat = async (path) => {
      const value = await restartStat(path);
      return value ? { ...value, ctime: 0 } : value;
    };
    const restarted = await ensureViewerAssets(restartedAdapter, pluginRoot, payload);
    assert.equal(restarted.metrics.cacheHit, true);
    assert.equal(restarted.metrics.statCacheFiles, payload.files.length);
    assert.deepEqual(restartedAdapter.binaryReads, []);
    const row = JSON.parse(storedMarker(state, first).text).statIndex[0];
    assert.equal(row.ctime, 0);
    assert.ok(row.mtime > 0);
  });

  await t.test("zero mtime", async () => {
    const state = createState();
    const payload = makePayload(3);
    await ensureViewerAssets(createStatAdapter(state), pluginRoot, payload);
    const adapter = createStatAdapter(state);
    const stat = adapter.stat.bind(adapter);
    adapter.stat = async (path) => {
      const value = await stat(path);
      return value ? { ...value, mtime: 0 } : value;
    };
    const checked = await ensureViewerAssets(adapter, pluginRoot, payload);
    assert.equal(checked.metrics.verificationReads, payload.files.length);
    assert.equal(adapter.binaryReads.length, payload.files.length);
    assert.deepEqual(adapter.binaryWrites, []);
    assert.equal(checked.metrics.statCacheFiles, undefined);
    const marker = JSON.parse(storedMarker(state, checked).text);
    assert.ok(marker.statIndex.every((row) => row.mtime === null));
  });
});

test("a stat snapshot race invalidates the candidate and repairs before committing", async () => {
  const state = createState();
  const payload = makePayload(4);
  const first = await ensureViewerAssets(
    createStatAdapter(state),
    pluginRoot,
    payload,
  );
  const file = payload.files[2];
  const path = `${first.rootPath}/${file.path}`;
  const prior = state.entries.get(path);
  state.clock += 1;
  state.entries.set(path, {
    bytes: new Uint8Array(prior.bytes),
    mtime: state.clock,
    ctime: prior.ctime,
  });
  let mutated = false;
  const adapter = createStatAdapter(state, {
    onRead(readPath) {
      if (readPath !== path || mutated) return;
      mutated = true;
      state.clock += 1;
      state.entries.set(path, {
        bytes: new Uint8Array(prior.bytes.length).fill(0x61),
        mtime: state.clock,
        ctime: state.clock,
      });
    },
  });
  const repaired = await ensureViewerAssets(adapter, pluginRoot, payload);
  assert.equal(mutated, true);
  assert.equal(repaired.metrics.repairedFiles, 1);
  assert.equal(Buffer.from(state.entries.get(path).bytes).toString(), "viewer-asset-2");
  const marker = JSON.parse(storedMarker(state, repaired).text);
  const row = marker.statIndex.find((entry) => entry.path === file.path);
  assert.equal(row.mtime, state.entries.get(path).mtime);
  assert.equal(row.ctime, state.entries.get(path).ctime);
});
