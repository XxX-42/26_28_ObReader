import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createPdfAnnotationStore } = require("../plugin/pdf-annotation-store.cjs");
const root = "00_Archive/20_PDFData";
const artifactDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "artifacts");

function hash(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;
}

function summarize(text) {
  if (typeof text !== "string") return null;
  try {
    const value = JSON.parse(text);
    if (value?.kind !== "pdf-annotation-checkpoint") return { kind: value?.kind || null };
    return {
      revision: value.revision,
      hash: value.integrity,
      annotationUUIDs: value.annotations.map(({ uuid }) => uuid).sort(),
      tombstoneUUIDs: value.tombstones.map(({ uuid }) => uuid).sort(),
      coveredBatchIds: Object.fromEntries(Object.entries(value.coveredBatches || {}).map(([device, batches]) =>
        [device, Object.keys(batches || {}).sort()])),
    };
  } catch { return { invalidJson: true }; }
}

function makeWorld({ deviceA = "device-A", deviceB = "device-B", deviceC = "tablet-C" } = {}) {
  const shared = { files: new Map(), folders: new Set() };
  const events = [];
  const removed = [];
  const gc = { A: [], B: [], C: [] };
  const makeAdapter = (name) => {
    const control = { beforeRead: null, beforeWrite: null, beforeRename: null, beforeList: null };
    const adapter = {
      control,
      async exists(file) {
        const result = shared.files.has(file) || shared.folders.has(file);
        events.push({ who: name, op: "exists", path: file, result });
        return result;
      },
      async mkdir(file) {
        shared.folders.add(file);
        events.push({ who: name, op: "mkdir", path: file });
      },
      async read(file) {
        if (control.beforeRead) await control.beforeRead(file);
        if (!shared.files.has(file)) {
          events.push({ who: name, op: "read-missing", path: file });
          throw Object.assign(new Error(`missing: ${file}`), { code: "ENOENT" });
        }
        const value = shared.files.get(file);
        events.push({ who: name, op: "read", path: file, checkpoint: summarize(value) });
        return value;
      },
      async write(file, value) {
        if (control.beforeWrite) await control.beforeWrite(file, value);
        const parent = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
        if (parent && !shared.folders.has(parent)) throw new Error(`parent directory missing: ${parent}`);
        shared.files.set(file, value);
        events.push({ who: name, op: "write", path: file, checkpoint: summarize(value) });
      },
      async rename(from, to) {
        if (control.beforeRename) await control.beforeRename(from, to);
        if (!shared.files.has(from)) throw new Error(`missing rename source: ${from}`);
        if (shared.files.has(to)) throw new Error(`rename target exists: ${to}`);
        shared.files.set(to, shared.files.get(from));
        shared.files.delete(from);
        events.push({ who: name, op: "rename", from, to });
      },
      async remove(file) {
        if (!shared.files.has(file)) throw Object.assign(new Error(`missing: ${file}`), { code: "ENOENT" });
        const before = shared.files.get(file);
        shared.files.delete(file);
        removed.push({ who: name, path: file, batch: summarizeBatch(before) });
        events.push({ who: name, op: "remove", path: file });
      },
      async list(file) {
        if (control.beforeList) await control.beforeList(file);
        const prefix = `${file}/`;
        const listedFiles = [];
        const listedFolders = new Set();
        for (const key of shared.files.keys()) {
          if (!key.startsWith(prefix)) continue;
          const remainder = key.slice(prefix.length);
          if (!remainder.includes("/")) listedFiles.push(key);
          else listedFolders.add(`${file}/${remainder.slice(0, remainder.indexOf("/"))}`);
        }
        for (const key of shared.folders) {
          if (!key.startsWith(prefix)) continue;
          const remainder = key.slice(prefix.length);
          if (remainder && !remainder.includes("/")) listedFolders.add(key);
        }
        events.push({ who: name, op: "list", path: file, fileCount: listedFiles.length });
        return { files: listedFiles, folders: [...listedFolders] };
      },
    };
    return { adapter, control };
  };
  const a = makeAdapter("A");
  const b = makeAdapter("B");
  const c = makeAdapter("C");
  let seqA = 0;
  let seqB = 0;
  const storeA = createPdfAnnotationStore({
    adapter: a.adapter, root, deviceId: deviceA, hash,
    uuid: () => `a-internal-${++seqA}`,
    onTiming: (event) => { if (event.phase === "gc") gc.A.push({ ...event }); },
  });
  const storeB = createPdfAnnotationStore({
    adapter: b.adapter, root, deviceId: deviceB, hash,
    uuid: () => `b-internal-${++seqB}`,
    onTiming: (event) => { if (event.phase === "gc") gc.B.push({ ...event }); },
  });
  let seqC = 0;
  const storeC = createPdfAnnotationStore({
    adapter: c.adapter, root, deviceId: deviceC, hash,
    uuid: () => `c-internal-${++seqC}`,
    onTiming: (event) => { if (event.phase === "gc") gc.C.push({ ...event }); },
  });
  return { shared, events, removed, gc, a, b, c, storeA, storeB, storeC, ids: { A: deviceA, B: deviceB, C: deviceC } };
}

function summarizeBatch(text) {
  try {
    const batch = JSON.parse(text);
    return { deviceId: batch.deviceId, batchId: batch.batchId, uuids: batch.operations.map(({ uuid }) => uuid) };
  } catch { return null; }
}

function operation(uuid, deviceId, timestamp) {
  return {
    uuid, kind: "Ink", pageIndex: 0, deleted: false, payload: { value: uuid },
    clock: { timestamp, logical: 0, deviceId, opId: `op-${uuid}` },
  };
}

function checkpointPair(world, paths) {
  return {
    primary: summarize(world.shared.files.get(paths.checkpoint)),
    backup: summarize(world.shared.files.get(paths.checkpointBackup)),
  };
}

async function persistEvidence(label, evidence) {
  await mkdir(artifactDir, { recursive: true });
  const gcAttempts = Object.values(evidence.gcEvents || {}).flat();
  evidence.gcSummary = {
    attempts: gcAttempts.length,
    successfulPasses: gcAttempts.filter(({ status }) => status === "success").length,
    reportedRemovedBatchCount: gcAttempts.reduce((sum, { removedBatchCount = 0 }) => sum + removedBatchCount, 0),
    actualAdapterRemoveCalls: (evidence.removedBatches || []).length,
    actualRemovedBatchPaths: (evidence.removedBatches || []).map(({ path: removedPath }) => removedPath),
  };
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const file = path.join(artifactDir, `store-cross-instance-race-${label}-${stamp}-${process.pid}.json`);
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return file;
}

function makePauseGate(world, evidence, paths) {
  let enteredResolve;
  let releaseResolve;
  let released = false;
  let used = false;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const held = new Promise((resolve) => { releaseResolve = resolve; });
  const gate = {
    arm() { world.a.control.beforeRead = async (file) => {
      if (file !== paths.checkpointBackup || used) return;
      used = true;
      evidence.pause = { who: "A", op: "read", path: file, checkpointAtPause: checkpointPair(world, paths) };
      world.events.push({ who: "A", op: "pause-before-read", path: file });
      enteredResolve();
      let timeoutId;
      await Promise.race([held, new Promise((resolve) => { timeoutId = setTimeout(resolve, 4000); })]);
      clearTimeout(timeoutId);
      world.a.control.beforeRead = null;
      world.events.push({ who: "A", op: "resume-read", path: file, released });
    }; },
    async wait() {
      let timeoutId;
      try {
        await Promise.race([entered, new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("A did not pause before checkpoint backup read")), 2500);
        })]);
      } finally { clearTimeout(timeoutId); }
    },
    release() {
      if (released) return;
      released = true;
      releaseResolve();
    },
    get used() { return used; },
  };
  return gate;
}

function makeAdapterGate(world, evidence, { side, controlField, predicate, label, paths }) {
  let enteredResolve;
  let releaseResolve;
  let released = false;
  let used = false;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const held = new Promise((resolve) => { releaseResolve = resolve; });
  const adapterSide = world[side.toLowerCase()];
  const original = adapterSide.control[controlField];
  const gate = {
    arm() {
      adapterSide.control[controlField] = async (...args) => {
        if (original) await original(...args);
        if (used || !predicate(...args)) return;
        used = true;
        evidence.pause = {
          who: side,
          op: label,
          args: args.slice(0, 2).map((value) => typeof value === "string" ? value : undefined),
          checkpointAtPause: paths ? checkpointPair(world, paths) : undefined,
        };
        world.events.push({ who: side, op: `pause-${label}`, path: typeof args[0] === "string" ? args[0] : null });
        enteredResolve();
        let timeoutId;
        await Promise.race([held, new Promise((resolve) => { timeoutId = setTimeout(resolve, 4000); })]);
        clearTimeout(timeoutId);
        adapterSide.control[controlField] = original;
        world.events.push({ who: side, op: `resume-${label}`, released });
      };
    },
    async wait() {
      let timeoutId;
      try {
        await Promise.race([entered, new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`${side} did not reach ${label} gate`)), 2500);
        })]);
      } finally { clearTimeout(timeoutId); }
    },
    release() {
      if (released) return;
      released = true;
      releaseResolve();
    },
    clear() { adapterSide.control[controlField] = original; },
    get used() { return used; },
  };
  return gate;
}

function makeConcurrentAppendBarrier(world, evidence, targets, label) {
  const arrivals = [];
  const originals = new Map();
  let enteredResolve;
  let releaseResolve;
  let released = false;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const held = new Promise((resolve) => { releaseResolve = resolve; });
  const barrierEvidence = {
    label,
    gate: "both appendOperations calls reached their final batch rename before either was released",
    expected: targets.map(({ side, path }) => ({ side, path })),
    arrivals,
    bothFacadesReached: false,
    released: false,
  };
  evidence.concurrentAppendBarriers ||= [];
  evidence.concurrentAppendBarriers.push(barrierEvidence);

  return {
    arm() {
      for (const target of targets) {
        const adapterSide = world[target.side.toLowerCase()];
        const original = adapterSide.control.beforeRename;
        originals.set(target.side, original);
        adapterSide.control.beforeRename = async (from, to) => {
          if (original) await original(from, to);
          if (to !== target.path) return;
          arrivals.push({ side: target.side, from, to });
          world.events.push({ who: target.side, op: "concurrent-append-await-rename", from, to });
          if (arrivals.length === targets.length) {
            barrierEvidence.bothFacadesReached = new Set(arrivals.map(({ side }) => side)).size === targets.length;
            enteredResolve();
          }
          await held;
          adapterSide.control.beforeRename = original;
          world.events.push({ who: target.side, op: "concurrent-append-resume-rename", from, to, released });
        };
      }
    },
    async wait() {
      let timeoutId;
      try {
        await Promise.race([entered, new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`${label}: both append facades did not reach the rename barrier`)), 2500);
        })]);
      } finally { clearTimeout(timeoutId); }
      assert.equal(barrierEvidence.bothFacadesReached, true, `${label}: A and B must both reach the barrier before release`);
    },
    release() {
      if (released) return;
      released = true;
      barrierEvidence.released = true;
      releaseResolve();
      for (const target of targets) {
        const adapterSide = world[target.side.toLowerCase()];
        adapterSide.control.beforeRename = originals.get(target.side) || null;
      }
    },
    snapshot() {
      return {
        label: barrierEvidence.label,
        gate: barrierEvidence.gate,
        expected: barrierEvidence.expected,
        arrivals: arrivals.map(({ side, from, to }) => ({ side, from, to })),
        bothFacadesReached: barrierEvidence.bothFacadesReached,
        released,
      };
    },
  };
}

function durableCheckpointAndPointer(world, paths) {
  let checkpoint = null;
  let snapshotPointer = null;
  try {
    checkpoint = JSON.parse(world.shared.files.get(paths.checkpoint) || "null");
  } catch { /* evidence keeps the invalid checkpoint visible as null */ }
  try {
    snapshotPointer = JSON.parse(world.shared.files.get(paths.snapshot) || "null");
  } catch { /* evidence keeps the invalid pointer visible as null */ }
  return {
    checkpoint: checkpoint ? {
      revision: checkpoint.revision,
      hash: checkpoint.integrity,
      annotationUUIDs: (checkpoint.annotations || []).map(({ uuid }) => uuid).sort(),
      tombstoneUUIDs: (checkpoint.tombstones || []).map(({ uuid }) => uuid).sort(),
      coveredBatches: checkpoint.coveredBatches || {},
    } : null,
    snapshotPointer,
  };
}

async function preparePair(world, sourcePath) {
  const documentA = await world.storeA.registerDocument({ sourcePath });
  const documentB = await world.storeB.registerDocument({ sourcePath });
  for (let i = 0; i < 5; i += 1) {
    await world.storeA.readDocument(documentA);
    await world.storeB.readDocument(documentB);
    const status = await world.storeB.inspectDevices(documentB);
    if (status.devices.filter(({ deviceId }) => [world.ids.A, world.ids.B].includes(deviceId))
      .every(({ acknowledged }) => acknowledged)) break;
  }
  const status = await world.storeB.inspectDevices(documentB);
  const deviceStates = status.devices.filter(({ deviceId }) => [world.ids.A, world.ids.B].includes(deviceId));
  assert.deepEqual(deviceStates.map(({ acknowledged }) => acknowledged), [true, true], "A and B must ACK the same baseline before the race");
  const paths = world.storeA.pathsFor(documentA);
  return { documentA, documentB, paths, baseline: checkpointPair(world, paths), baselineDevices: deviceStates };
}

test("independent stale replay cannot overwrite a newer checkpoint", async () => {
  const world = makeWorld();
  const evidence = {
    label: "stale-replay-overwrite",
    protocol: "two independent store instances and adapter facades share only a durable backing map; no mutex is shared",
    facadeProof: { separateAdapters: world.a.adapter !== world.b.adapter, separateStores: world.storeA !== world.storeB, sharedBacking: true },
    events: world.events, removedBatches: world.removed, gcEvents: world.gc,
  };
  let gate;
  let oldRead;
  let artifactPath;
  try {
    const { documentA, documentB, paths, baseline, baselineDevices } = await preparePair(world, "cross-instance-stale.pdf");
    evidence.baseline = baseline;
    evidence.baselineDevices = baselineDevices;
    evidence.paths = paths;
    gate = makePauseGate(world, evidence, paths);
    gate.arm();
    oldRead = world.storeA.readDocument(documentA);
    await gate.wait();
    evidence.checkpointBeforeB = checkpointPair(world, paths);

    const appended = await world.storeB.appendOperations({
      document: documentB, batchId: "b-new-acknowledged", operations: [operation("annotation-B-new", "device-B", 200)],
    });
    evidence.appendedBatch = { path: appended.batchPath, exists: world.shared.files.has(appended.batchPath) };
    const bSnapshot = await world.storeB.readDocument(documentB);
    evidence.bSnapshot = { revision: bSnapshot.revision, annotationUUIDs: bSnapshot.annotations.map(({ uuid }) => uuid).sort() };
    evidence.checkpointAfterB = checkpointPair(world, paths);
    evidence.batchBeforeStaleResume = { path: appended.batchPath, exists: world.shared.files.has(appended.batchPath) };
    evidence.devicesAfterB = await world.storeB.inspectDevices(documentB);

    gate.release();
    const aSnapshot = await oldRead;
    evidence.aStaleSnapshot = { revision: aSnapshot.revision, annotationUUIDs: aSnapshot.annotations.map(({ uuid }) => uuid).sort() };
    evidence.checkpointAfterStaleA = checkpointPair(world, paths);
    evidence.batchAfterStaleA = { path: appended.batchPath, exists: world.shared.files.has(appended.batchPath) };
    evidence.realGcCount = world.gc.A.length + world.gc.B.length;
    evidence.finalDurable = checkpointPair(world, paths);
    evidence.artifactPath = artifactPath = await persistEvidence(evidence.label, evidence);

    assert.equal(evidence.finalDurable.primary?.hash, evidence.checkpointAfterB.primary?.hash,
      "stale replay A must not replace B's newer durable checkpoint");
    assert.ok(evidence.finalDurable.primary.annotationUUIDs.includes("annotation-B-new"),
      "the newer acknowledged annotation must remain in the primary checkpoint");
  } finally {
    gate?.release();
    if (oldRead) await Promise.race([oldRead.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 4500))]);
    if (!artifactPath) {
      evidence.finalDurable = evidence.paths ? checkpointPair(world, evidence.paths) : null;
      evidence.artifactPath = await persistEvidence(evidence.label, evidence);
    }
  }
});

test("retired-device stale replay cannot erase a batch after real GC", async () => {
  const world = makeWorld();
  const evidence = {
    label: "retired-stale-replay-after-gc",
    protocol: "two independent store instances and adapter facades share only a durable backing map; no mutex is shared",
    facadeProof: { separateAdapters: world.a.adapter !== world.b.adapter, separateStores: world.storeA !== world.storeB, sharedBacking: true },
    events: world.events, removedBatches: world.removed, gcEvents: world.gc,
  };
  let gate;
  let oldRead;
  let artifactPath;
  try {
    const { documentA, documentB, paths, baseline, baselineDevices } = await preparePair(world, "cross-instance-retire-gc.pdf");
    evidence.baseline = baseline;
    evidence.baselineDevices = baselineDevices;
    evidence.paths = paths;
    gate = makePauseGate(world, evidence, paths);
    gate.arm();
    oldRead = world.storeA.readDocument(documentA);
    await gate.wait();

    const appended = await world.storeB.appendOperations({
      document: documentB, batchId: "b-retire-gc", operations: [operation("annotation-B-retired-gc", "device-B", 300)],
    });
    evidence.appendedBatch = { path: appended.batchPath, exists: world.shared.files.has(appended.batchPath) };
    const bSnapshot = await world.storeB.readDocument(documentB);
    evidence.checkpointAfterB = checkpointPair(world, paths);
    evidence.batchBeforeRetirement = { path: appended.batchPath, exists: world.shared.files.has(appended.batchPath) };
    evidence.bSnapshot = { revision: bSnapshot.revision, annotationUUIDs: bSnapshot.annotations.map(({ uuid }) => uuid).sort() };

    const confirmedHash = evidence.checkpointAfterB.primary?.hash;
    const retirement = await world.storeB.retireDevice({
      document: documentB, targetDeviceId: "device-A", confirmedCheckpointHash: confirmedHash,
    });
    evidence.publicRetirement = retirement;
    const postRetireSnapshot = await world.storeB.readDocument(documentB);
    evidence.postRetirementSnapshot = { revision: postRetireSnapshot.revision, annotationUUIDs: postRetireSnapshot.annotations.map(({ uuid }) => uuid).sort() };
    evidence.checkpointAfterRetirementGC = checkpointPair(world, paths);
    evidence.batchAfterRealGC = { path: appended.batchPath, exists: world.shared.files.has(appended.batchPath) };
    evidence.retiredDeviceState = JSON.parse(world.shared.files.get(`${paths.deviceStates}/device-A.json`));
    evidence.realGcCount = world.gc.A.length + world.gc.B.length;
    evidence.realRemoves = world.removed.filter(({ path: removedPath }) => removedPath === appended.batchPath);

    gate.release();
    const aSnapshot = await oldRead;
    evidence.aStaleSnapshot = { revision: aSnapshot.revision, annotationUUIDs: aSnapshot.annotations.map(({ uuid }) => uuid).sort() };
    evidence.checkpointAfterStaleA = checkpointPair(world, paths);
    evidence.batchAfterStaleA = { path: appended.batchPath, exists: world.shared.files.has(appended.batchPath) };
    const bAfter = await world.storeB.readDocument(documentB);
    evidence.bAfterStaleA = { revision: bAfter.revision, annotationUUIDs: bAfter.annotations.map(({ uuid }) => uuid).sort() };
    evidence.finalDurable = checkpointPair(world, paths);
    evidence.finalDevices = await world.storeB.inspectDevices(documentB);
    evidence.artifactPath = artifactPath = await persistEvidence(evidence.label, evidence);

    assert.ok(evidence.realRemoves.length >= 1, "B must remove the covered immutable batch through the real GC path");
    assert.ok(evidence.gcEvents.B.some(({ status, removedBatchCount }) => status === "success" && removedBatchCount >= 1),
      "B must report a successful GC that removed a batch");
    assert.ok(evidence.bAfterStaleA.annotationUUIDs.includes("annotation-B-retired-gc"),
      "a retired-device stale replay must not permanently erase B's acknowledged, GC'd annotation");
  } finally {
    gate?.release();
    if (oldRead) await Promise.race([oldRead.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 4500))]);
    if (!artifactPath) {
      evidence.finalDurable = evidence.paths ? checkpointPair(world, evidence.paths) : null;
      evidence.artifactPath = await persistEvidence(evidence.label, evidence);
    }
  }
});

test("GC must leave an operation batch created after its checkpoint snapshot", async () => {
  const world = makeWorld({ deviceA: "windows-A", deviceB: "ipad-B" });
  const evidence = {
    label: "gc-candidate-plus-new-batch",
    protocol: "independent windows-A/ipad-B store instances; shared durable map only",
    facadeProof: { separateAdapters: world.a.adapter !== world.b.adapter, separateStores: world.storeA !== world.storeB, sharedBacking: true },
    events: world.events, removedBatches: world.removed, gcEvents: world.gc,
  };
  let gate;
  let materialization;
  try {
    const { documentA, documentB, paths, baseline } = await preparePair(world, "cross-instance-gc-new-batch.pdf");
    evidence.baseline = baseline;
    evidence.paths = paths;
    const old = await world.storeA.appendOperations({
      document: documentA, batchId: "a-old-covered", operations: [operation("annotation-old", world.ids.A, 10)],
    });
    await world.storeA.readDocument(documentA);
    const bRemove = world.b.adapter.remove;
    world.b.adapter.remove = undefined;
    await world.storeB.readDocument(documentB); // B ACKs the checkpoint without running GC.
    world.b.adapter.remove = bRemove;
    evidence.oldBatchBeforeRace = { path: old.batchPath, exists: world.shared.files.has(old.batchPath) };

    let operationLists = 0;
    gate = makeAdapterGate(world, evidence, {
      side: "B", controlField: "beforeList", label: "GC operation-list scan",
      predicate: (file) => file === paths.operations && ++operationLists === 2,
      paths,
    });
    gate.arm();
    materialization = world.storeB.readDocument(documentB);
    await gate.wait();
    const newer = await world.storeA.appendOperations({
      document: documentA, batchId: "a-created-during-gc", operations: [operation("annotation-during-gc", world.ids.A, 20)],
    });
    evidence.newBatchWhileGC = { path: newer.batchPath, exists: world.shared.files.has(newer.batchPath) };
    gate.release();
    const snapshot = await materialization;
    evidence.gcSnapshot = { revision: snapshot.revision, annotationUUIDs: snapshot.annotations.map(({ uuid }) => uuid).sort() };
    evidence.afterGC = checkpointPair(world, paths);
    evidence.oldBatchAfterGC = { path: old.batchPath, exists: world.shared.files.has(old.batchPath) };
    evidence.newBatchAfterGC = { path: newer.batchPath, exists: world.shared.files.has(newer.batchPath) };
    evidence.realGcCount = world.gc.A.length + world.gc.B.length;
    evidence.finalDevices = await world.storeB.inspectDevices(documentB);
    evidence.artifactPath = await persistEvidence(evidence.label, evidence);

    assert.ok(world.gc.B.some(({ status, removedBatchCount }) => status === "success" && removedBatchCount >= 1),
      "the test must exercise a real eligible GC pass");
    assert.equal(evidence.oldBatchAfterGC.exists, false, "the pre-existing covered candidate should be collected");
    assert.equal(evidence.newBatchAfterGC.exists, true, "GC must not remove a batch absent from its checkpoint manifest");
  } finally {
    gate?.release();
    if (materialization) await Promise.race([materialization.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 4500))]);
    if (!evidence.artifactPath) {
      evidence.afterGC = evidence.paths ? checkpointPair(world, evidence.paths) : null;
      evidence.artifactPath = await persistEvidence(evidence.label, evidence);
    }
  }
});

test("concurrent different UUID batches remain recoverable while a stale writer regresses the cache", async () => {
  const world = makeWorld({ deviceA: "windows-A", deviceB: "ipad-B" });
  const evidence = {
    label: "concurrent-different-uuids",
    protocol: "independent windows-A/ipad-B store instances; shared durable map only",
    facadeProof: { separateAdapters: world.a.adapter !== world.b.adapter, separateStores: world.storeA !== world.storeB, sharedBacking: true },
    events: world.events, removedBatches: world.removed, gcEvents: world.gc,
  };
  let gate;
  let appendBarrier;
  let staleRead;
  let appendPromises = [];
  try {
    const { documentA, documentB, paths, baseline } = await preparePair(world, "cross-instance-distinct-uuid.pdf");
    evidence.baseline = baseline;
    evidence.paths = paths;
    const initial = await world.storeA.appendOperations({
      document: documentA, batchId: "a-distinct", operations: [operation("annotation-A", world.ids.A, 100)],
    });
    gate = makePauseGate(world, evidence, paths);
    gate.arm();
    staleRead = world.storeA.readDocument(documentA);
    await gate.wait();
    const concurrentAPath = `${world.storeA.pathsFor(documentA).deviceOperations}/a-distinct-concurrent.json`;
    const concurrentBPath = `${world.storeB.pathsFor(documentB).deviceOperations}/b-distinct-concurrent.json`;
    appendBarrier = makeConcurrentAppendBarrier(world, evidence, [
      { side: "A", path: concurrentAPath },
      { side: "B", path: concurrentBPath },
    ], "different UUID A/B batch append");
    appendBarrier.arm();
    appendPromises = [
      world.storeA.appendOperations({
        document: documentA, batchId: "a-distinct-concurrent", operations: [operation("annotation-A-concurrent", world.ids.A, 105)],
      }),
      world.storeB.appendOperations({
        document: documentB, batchId: "b-distinct-concurrent", operations: [operation("annotation-B", world.ids.B, 110)],
      }),
    ];
    await appendBarrier.wait();
    appendBarrier.release();
    const [concurrentA, concurrentB] = await Promise.all(appendPromises);
    evidence.concurrentAppendBatchPaths = [concurrentA.batchPath, concurrentB.batchPath];
    evidence.concurrentAppendBarrier = appendBarrier.snapshot();
    gate.release();
    const aSnapshot = await staleRead;
    evidence.staleASnapshot = { revision: aSnapshot.revision, annotationUUIDs: aSnapshot.annotations.map(({ uuid }) => uuid).sort() };
    evidence.checkpointAfterStaleA = checkpointPair(world, paths);
    evidence.aConcurrentBatchAfterStaleA = { path: concurrentA.batchPath, exists: world.shared.files.has(concurrentA.batchPath) };
    evidence.bBatchAfterStaleA = { path: concurrentB.batchPath, exists: world.shared.files.has(concurrentB.batchPath) };
    const recovery = await world.storeB.readDocument(documentB);
    evidence.recoverySnapshot = { revision: recovery.revision, annotationUUIDs: recovery.annotations.map(({ uuid }) => uuid).sort() };
    evidence.finalDurable = checkpointPair(world, paths);
    evidence.finalStoreState = durableCheckpointAndPointer(world, paths);
    evidence.initialBatchPath = initial.batchPath;
    evidence.realGcCount = world.gc.A.length + world.gc.B.length;
    evidence.artifactPath = await persistEvidence(evidence.label, evidence);

    assert.equal(evidence.concurrentAppendBarrier.bothFacadesReached, true,
      "both independent adapters must be blocked at final rename before either operation is released");
    assert.deepEqual(evidence.recoverySnapshot.annotationUUIDs,
      ["annotation-A", "annotation-A-concurrent", "annotation-B"],
      "the initial checkpoint and both concurrently appended UUIDs must be recoverable");
    assert.equal(evidence.aConcurrentBatchAfterStaleA.exists, true,
      "A's concurrently appended batch must remain outside the stale checkpoint manifest");
    assert.equal(evidence.bBatchAfterStaleA.exists, true,
      "B's concurrently appended batch must remain outside the stale checkpoint manifest");
  } finally {
    appendBarrier?.release();
    gate?.release();
    if (appendPromises.length) await Promise.race([Promise.allSettled(appendPromises), new Promise((resolve) => setTimeout(resolve, 4500))]);
    if (staleRead) await Promise.race([staleRead.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 4500))]);
    if (!evidence.artifactPath) {
      evidence.finalDurable = evidence.paths ? checkpointPair(world, evidence.paths) : null;
      evidence.artifactPath = await persistEvidence(evidence.label, evidence);
    }
  }
});

test("same-UUID concurrent edits converge by Lamport last-writer-wins", async () => {
  const world = makeWorld({ deviceA: "windows-A", deviceB: "ipad-B" });
  const evidence = {
    label: "same-uuid-lww",
    protocol: "independent windows-A/ipad-B store instances; shared durable map only",
    facadeProof: { separateAdapters: world.a.adapter !== world.b.adapter, separateStores: world.storeA !== world.storeB, sharedBacking: true },
    events: world.events, removedBatches: world.removed, gcEvents: world.gc,
  };
  let appendBarrier;
  let appendPromises = [];
  try {
    const { documentA, documentB, paths, baseline } = await preparePair(world, "cross-instance-same-uuid.pdf");
    evidence.baseline = baseline;
    evidence.paths = paths;
    appendBarrier = makeConcurrentAppendBarrier(world, evidence, [
      { side: "A", path: `${world.storeA.pathsFor(documentA).deviceOperations}/a-same-uuid.json` },
      { side: "B", path: `${world.storeB.pathsFor(documentB).deviceOperations}/b-same-uuid.json` },
    ], "same UUID A/B edits");
    appendBarrier.arm();
    appendPromises = [
      world.storeA.appendOperations({ document: documentA, batchId: "a-same-uuid", operations: [operation("shared-uuid", world.ids.A, 100)] }),
      world.storeB.appendOperations({ document: documentB, batchId: "b-same-uuid", operations: [operation("shared-uuid", world.ids.B, 200)] }),
    ];
    await appendBarrier.wait();
    appendBarrier.release();
    const [aBatch, bBatch] = await Promise.all(appendPromises);
    evidence.batchPaths = [aBatch.batchPath, bBatch.batchPath];
    evidence.concurrentAppendBarrier = appendBarrier.snapshot();
    const aSnapshot = await world.storeA.readDocument(documentA);
    const bSnapshot = await world.storeB.readDocument(documentB);
    const winnerA = aSnapshot.annotations.find(({ uuid }) => uuid === "shared-uuid");
    const winnerB = bSnapshot.annotations.find(({ uuid }) => uuid === "shared-uuid");
    evidence.snapshots = [aSnapshot, bSnapshot].map(({ revision, annotations }) => ({
      revision, rows: annotations.filter(({ uuid }) => uuid === "shared-uuid").map(({ uuid, payload, clock }) => ({ uuid, payload, clock })),
    }));
    evidence.finalDurable = checkpointPair(world, paths);
    evidence.finalStoreState = durableCheckpointAndPointer(world, paths);
    evidence.realGcCount = world.gc.A.length + world.gc.B.length;
    evidence.artifactPath = await persistEvidence(evidence.label, evidence);

    assert.equal(evidence.concurrentAppendBarrier.bothFacadesReached, true,
      "both independent adapters must be blocked at final rename before either operation is released");
    assert.equal(winnerA?.clock.timestamp, 200, "A must resolve the later clock from B");
    assert.equal(winnerB?.clock.timestamp, 200, "B must resolve the later clock from B");
    assert.equal(winnerA?.payload?.value, "shared-uuid", "the same UUID should have exactly one live winner");
  } finally {
    appendBarrier?.release();
    if (appendPromises.length) await Promise.race([Promise.allSettled(appendPromises), new Promise((resolve) => setTimeout(resolve, 4500))]);
    if (!evidence.artifactPath) {
      evidence.finalDurable = evidence.paths ? checkpointPair(world, evidence.paths) : null;
      evidence.artifactPath = await persistEvidence(evidence.label, evidence);
    }
  }
});

test("an unretired device's new batch below the checkpoint timestamp remains replayable", async () => {
  const world = makeWorld({ deviceA: "windows-A", deviceB: "ipad-B" });
  const evidence = {
    label: "unretired-old-clock-new-batch",
    protocol: "independent windows-A/ipad-B stores; public ACKs and compact checkpoint; only the shared durable map is shared",
    facadeProof: { separateAdapters: world.a.adapter !== world.b.adapter, separateStores: world.storeA !== world.storeB, sharedBacking: true },
    events: world.events, removedBatches: world.removed, gcEvents: world.gc,
  };
  try {
    const { documentA, documentB, paths, baseline } = await preparePair(world, "cross-instance-old-clock-new-batch.pdf");
    evidence.baseline = baseline;
    evidence.paths = paths;
    const anchor = await world.storeA.appendOperations({
      document: documentA, batchId: "a-watermark-anchor", operations: [operation("annotation-watermark-anchor", world.ids.A, 200)],
    });
    await world.storeA.readDocument(documentA);
    await world.storeB.readDocument(documentB);
    const startCheckpoint = JSON.parse(world.shared.files.get(paths.checkpoint));
    const startDevices = await world.storeB.inspectDevices(documentB);
    evidence.acknowledgedCompactStart = {
      revision: startCheckpoint.revision,
      hash: startCheckpoint.integrity,
      payloadEncoding: startCheckpoint.payloadEncoding,
      updatedAt: startCheckpoint.updatedAt,
      annotationUUIDs: startCheckpoint.annotations.map(({ uuid }) => uuid).sort(),
      coveredBatches: startCheckpoint.coveredBatches,
      devices: startDevices.devices.filter(({ deviceId }) => [world.ids.A, world.ids.B].includes(deviceId)),
      anchorBatchAfterAck: { path: anchor.batchPath, exists: world.shared.files.has(anchor.batchPath) },
    };
    assert.equal(startCheckpoint.payloadEncoding, "float32le-base64-v1",
      "the watermark case must start from a compact checkpoint");
    assert.equal(startCheckpoint.updatedAt, 200, "the compact checkpoint watermark must be newer than the late operation clock");
    assert.deepEqual(evidence.acknowledgedCompactStart.devices.map(({ acknowledged }) => acknowledged), [true, true],
      "both unretired devices must ACK the exact same checkpoint before the old-clock batch is appended");
    assert.equal(evidence.acknowledgedCompactStart.devices.every(({ retired }) => retired === false), true,
      "the old-clock operation must come from a registered but unretired device");
    assert.ok(startCheckpoint.coveredBatches[world.ids.A]?.["a-watermark-anchor"],
      "the checkpoint must already cover the anchor operation before the late batch is written");
    assert.equal(world.shared.files.has(anchor.batchPath), false,
      "the anchor batch must already be collected so it cannot explain recovery of the later annotation");

    const late = await world.storeA.appendOperations({
      document: documentA, batchId: "a-old-clock-new-uuid", operations: [operation("annotation-new-old-clock", world.ids.A, 50)],
    });
    evidence.newBatchBeforeReplay = { path: late.batchPath, exists: world.shared.files.has(late.batchPath) };
    const replayed = await world.storeB.readDocument(documentB);
    evidence.snapshotAfterOldTimestampBatch = {
      revision: replayed.revision,
      updatedAt: replayed.updatedAt,
      annotationUUIDs: replayed.annotations.map(({ uuid }) => uuid).sort(),
    };
    evidence.finalDurable = checkpointPair(world, paths);
    evidence.finalStoreState = durableCheckpointAndPointer(world, paths);
    evidence.devicesAfterReplay = await world.storeB.inspectDevices(documentB);
    evidence.newBatchAfterReplay = { path: late.batchPath, exists: world.shared.files.has(late.batchPath) };
    evidence.artifactPath = await persistEvidence(evidence.label, evidence);

    assert.equal(evidence.newBatchBeforeReplay.exists, true, "the late A batch must be durable before B replays");
    assert.ok(evidence.snapshotAfterOldTimestampBatch.annotationUUIDs.includes("annotation-new-old-clock"),
      "an unretired A batch with timestamp below checkpoint.updatedAt must not be suppressed as stale");
    assert.equal(evidence.snapshotAfterOldTimestampBatch.updatedAt, 200,
      "the older operation timestamp must not move the checkpoint watermark backwards");
  } finally {
    if (!evidence.artifactPath) {
      evidence.finalStoreState = evidence.paths ? durableCheckpointAndPointer(world, evidence.paths) : null;
      evidence.artifactPath = await persistEvidence(evidence.label, evidence);
    }
  }
});

test("delete/edit races choose the later clock in both directions", async () => {
  const world = makeWorld({ deviceA: "windows-A", deviceB: "ipad-B" });
  const evidence = {
    label: "delete-edit-both-directions",
    protocol: "independent windows-A/ipad-B store instances; shared durable map only",
    facadeProof: { separateAdapters: world.a.adapter !== world.b.adapter, separateStores: world.storeA !== world.storeB, sharedBacking: true },
    events: world.events, removedBatches: world.removed, gcEvents: world.gc, cases: [], concurrentAppendBarriers: [],
  };
  const tombstone = (uuid, actor, timestamp) => ({
    uuid, kind: "Ink", pageIndex: 0, deleted: true,
    clock: { timestamp, logical: 0, deviceId: actor, opId: `delete-${uuid}-${timestamp}` },
  });
  let activeAppendBarrier;
  let activeAppendPromises = [];
  try {
    const first = await preparePair(world, "cross-instance-delete-wins.pdf");
    const { documentA: docA1, documentB: docB1, paths: paths1 } = first;
    activeAppendBarrier = makeConcurrentAppendBarrier(world, evidence, [
      { side: "A", path: `${world.storeA.pathsFor(docA1).deviceOperations}/a-edit-before-delete.json` },
      { side: "B", path: `${world.storeB.pathsFor(docB1).deviceOperations}/b-delete-after-edit.json` },
    ], "delete after edit concurrent appends");
    activeAppendBarrier.arm();
    activeAppendPromises = [
      world.storeA.appendOperations({ document: docA1, batchId: "a-edit-before-delete", operations: [operation("delete-wins", world.ids.A, 100)] }),
      world.storeB.appendOperations({ document: docB1, batchId: "b-delete-after-edit", operations: [tombstone("delete-wins", world.ids.B, 200)] }),
    ];
    await activeAppendBarrier.wait();
    activeAppendBarrier.release();
    const [deleteWinsA, deleteWinsB] = await Promise.all(activeAppendPromises);
    const deleteWinsBarrier = activeAppendBarrier.snapshot();
    activeAppendBarrier = null;
    activeAppendPromises = [];
    const deleted = await world.storeB.readDocument(docB1);
    evidence.cases.push({ direction: "delete-after-edit", snapshot: {
      revision: deleted.revision, annotationUUIDs: deleted.annotations.map(({ uuid }) => uuid), tombstoneUUIDs: deleted.tombstones.map(({ uuid }) => uuid),
    }, appendBarrier: deleteWinsBarrier, batchPaths: [deleteWinsA.batchPath, deleteWinsB.batchPath],
    durable: checkpointPair(world, paths1), durableState: durableCheckpointAndPointer(world, paths1) });
    assert.equal(deleted.annotations.some(({ uuid }) => uuid === "delete-wins"), false);
    assert.equal(deleted.tombstones.some(({ uuid }) => uuid === "delete-wins"), true);

    const second = await preparePair(world, "cross-instance-edit-wins.pdf");
    const { documentA: docA2, documentB: docB2, paths: paths2 } = second;
    activeAppendBarrier = makeConcurrentAppendBarrier(world, evidence, [
      { side: "A", path: `${world.storeA.pathsFor(docA2).deviceOperations}/a-delete-before-edit.json` },
      { side: "B", path: `${world.storeB.pathsFor(docB2).deviceOperations}/b-edit-after-delete.json` },
    ], "edit after delete concurrent appends");
    activeAppendBarrier.arm();
    activeAppendPromises = [
      world.storeA.appendOperations({ document: docA2, batchId: "a-delete-before-edit", operations: [tombstone("edit-wins", world.ids.A, 300)] }),
      world.storeB.appendOperations({ document: docB2, batchId: "b-edit-after-delete", operations: [operation("edit-wins", world.ids.B, 400)] }),
    ];
    await activeAppendBarrier.wait();
    activeAppendBarrier.release();
    const [editWinsA, editWinsB] = await Promise.all(activeAppendPromises);
    const editWinsBarrier = activeAppendBarrier.snapshot();
    activeAppendBarrier = null;
    activeAppendPromises = [];
    const edited = await world.storeA.readDocument(docA2);
    evidence.cases.push({ direction: "edit-after-delete", snapshot: {
      revision: edited.revision, annotationUUIDs: edited.annotations.map(({ uuid }) => uuid), tombstoneUUIDs: edited.tombstones.map(({ uuid }) => uuid),
    }, appendBarrier: editWinsBarrier, batchPaths: [editWinsA.batchPath, editWinsB.batchPath],
    durable: checkpointPair(world, paths2), durableState: durableCheckpointAndPointer(world, paths2) });
    assert.equal(edited.annotations.some(({ uuid }) => uuid === "edit-wins"), true);
    assert.equal(edited.tombstones.some(({ uuid }) => uuid === "edit-wins"), false);
    evidence.realGcCount = world.gc.A.length + world.gc.B.length;
    evidence.artifactPath = await persistEvidence(evidence.label, evidence);
    assert.equal(evidence.cases.every(({ appendBarrier }) => appendBarrier?.bothFacadesReached === true), true,
      "both delete/edit directions must append from A and B before either rename is released");
  } finally {
    activeAppendBarrier?.release();
    if (activeAppendPromises.length) await Promise.race([Promise.allSettled(activeAppendPromises), new Promise((resolve) => setTimeout(resolve, 4500))]);
    if (!evidence.artifactPath) evidence.artifactPath = await persistEvidence(evidence.label, evidence);
  }
});

test("a public retirement blocks an in-flight late batch and later appends", async () => {
  const world = makeWorld({ deviceA: "windows-A", deviceB: "ipad-B" });
  const evidence = {
    label: "retired-late-inflight",
    protocol: "independent windows-A/ipad-B store instances; shared durable map only",
    facadeProof: { separateAdapters: world.a.adapter !== world.b.adapter, separateStores: world.storeA !== world.storeB, sharedBacking: true },
    events: world.events, removedBatches: world.removed, gcEvents: world.gc,
  };
  let gate;
  let inflight;
  try {
    const { documentA, documentB, paths, baseline } = await preparePair(world, "cross-instance-retired-late.pdf");
    evidence.baseline = baseline;
    evidence.paths = paths;
    gate = makeAdapterGate(world, evidence, {
      side: "A", controlField: "beforeRename", label: "in-flight batch final rename",
      predicate: (from, to) => typeof to === "string" && to === `${paths.deviceOperations}/a-inflight-retired.json`, paths,
    });
    gate.arm();
    inflight = world.storeA.appendOperations({
      document: documentA, batchId: "a-inflight-retired", operations: [operation("annotation-inflight-retired", world.ids.A, 500)],
    });
    await gate.wait();
    const current = checkpointPair(world, paths).primary;
    evidence.retirement = await world.storeB.retireDevice({
      document: documentB, targetDeviceId: world.ids.A, confirmedCheckpointHash: current.hash,
    });
    await world.storeB.readDocument(documentB);
    evidence.beforeResume = { checkpoint: checkpointPair(world, paths), batchExists: world.shared.files.has(`${paths.deviceOperations}/a-inflight-retired.json`) };
    gate.release();
    evidence.inflightAppendOutcome = await inflight;
    evidence.batchAfterInflight = { path: evidence.inflightAppendOutcome.batchPath, exists: world.shared.files.has(evidence.inflightAppendOutcome.batchPath) };
    const lateAppend = await world.storeA.appendOperations({
      document: documentA, batchId: "a-after-retirement", operations: [operation("annotation-after-retirement", world.ids.A, 510)],
    }).then(() => ({ status: "fulfilled" }), (error) => ({ status: "rejected", code: error.code }));
    evidence.lateAppendOutcome = lateAppend;
    const snapshot = await world.storeB.readDocument(documentB);
    evidence.finalSnapshot = { revision: snapshot.revision, annotationUUIDs: snapshot.annotations.map(({ uuid }) => uuid).sort() };
    evidence.finalDurable = checkpointPair(world, paths);
    evidence.finalDevices = await world.storeB.inspectDevices(documentB);
    evidence.realGcCount = world.gc.A.length + world.gc.B.length;
    evidence.artifactPath = await persistEvidence(evidence.label, evidence);

    assert.equal(lateAppend.status, "rejected", "a new append after retirement must be refused by the public API");
    assert.equal(evidence.finalSnapshot.annotationUUIDs.includes("annotation-inflight-retired"), false,
      "an in-flight unacknowledged append that finalizes after retirement must not resurrect retired history");
    assert.equal(evidence.finalDevices.devices.find(({ deviceId }) => deviceId === world.ids.A)?.retired, true);
  } finally {
    gate?.release();
    if (inflight) await Promise.race([inflight.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 4500))]);
    if (!evidence.artifactPath) evidence.artifactPath = await persistEvidence(evidence.label, evidence);
  }
});

test("primary/backup competition is repaired by a fresh third store from retained batches", async () => {
  const world = makeWorld({ deviceA: "windows-A", deviceB: "ipad-B", deviceC: "tablet-C" });
  const evidence = {
    label: "primary-backup-competition",
    protocol: "independent windows-A/ipad-B/tablet-C stores; shared durable map only",
    facadeProof: { separateAdapters: world.a.adapter !== world.b.adapter && world.b.adapter !== world.c.adapter && world.a.adapter !== world.c.adapter,
      separateStores: world.storeA !== world.storeB && world.storeB !== world.storeC && world.storeA !== world.storeC, sharedBacking: true },
    events: world.events, removedBatches: world.removed, gcEvents: world.gc,
  };
  let gate;
  let staleRead;
  try {
    const { documentA, documentB, paths, baseline } = await preparePair(world, "cross-instance-primary-backup.pdf");
    evidence.baseline = baseline;
    evidence.paths = paths;
    const aBatch = await world.storeA.appendOperations({
      document: documentA, batchId: "a-primary-backup", operations: [operation("annotation-A-primary-backup", world.ids.A, 590)],
    });
    gate = makeAdapterGate(world, evidence, {
      side: "A", controlField: "beforeWrite", label: "primary checkpoint write after stale backup write",
      predicate: (file) => file === paths.checkpoint, paths,
    });
    gate.arm();
    staleRead = world.storeA.readDocument(documentA);
    await gate.wait(); // A has written rev1 to backup, but has not replaced the primary yet.
    const appended = await world.storeB.appendOperations({
      document: documentB, batchId: "b-primary-backup", operations: [operation("annotation-primary-backup", world.ids.B, 600)],
    });
    await world.storeB.readDocument(documentB);
    evidence.pairAfterB = checkpointPair(world, paths);
    evidence.aBatch = { path: aBatch.batchPath, exists: world.shared.files.has(aBatch.batchPath) };
    evidence.batchAfterB = { path: appended.batchPath, exists: world.shared.files.has(appended.batchPath) };
    gate.release();
    const stale = await staleRead;
    evidence.staleSnapshot = { revision: stale.revision, annotationUUIDs: stale.annotations.map(({ uuid }) => uuid) };
    evidence.mixedPairBeforeC = checkpointPair(world, paths);
    evidence.batchBeforeC = { path: appended.batchPath, exists: world.shared.files.has(appended.batchPath) };

    const documentC = await world.storeC.registerDocument({ sourcePath: "cross-instance-primary-backup.pdf" });
    const cSnapshot = await world.storeC.readDocument(documentC);
    evidence.cFreshSnapshot = { revision: cSnapshot.revision, annotationUUIDs: cSnapshot.annotations.map(({ uuid }) => uuid).sort() };
    evidence.finalPairAfterC = checkpointPair(world, paths);
    evidence.cCheckpointReads = world.events.filter(({ who, op, path: file }) => who === "C" && op === "read" &&
      [paths.checkpoint, paths.checkpointBackup].includes(file));
    evidence.realGcCount = world.gc.A.length + world.gc.B.length + world.gc.C.length;
    evidence.artifactPath = await persistEvidence(evidence.label, evidence);

    assert.equal(evidence.mixedPairBeforeC.primary?.revision, 1, "the forced competing primary should be the stale revision 1 checkpoint");
    assert.equal(evidence.mixedPairBeforeC.backup?.revision, 2, "the backup should retain B's newer verified revision 2 checkpoint");
    assert.equal(evidence.batchBeforeC.exists, true, "the unacknowledged batch must remain available for fresh-store repair");
    assert.deepEqual(evidence.cFreshSnapshot.annotationUUIDs, ["annotation-A-primary-backup", "annotation-primary-backup"].sort(),
      "a genuinely new store must recover B's annotation and preserve A's primary state");
  } finally {
    gate?.release();
    if (staleRead) await Promise.race([staleRead.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 4500))]);
    if (!evidence.artifactPath) {
      evidence.finalPairAfterC = evidence.paths ? checkpointPair(world, evidence.paths) : null;
      evidence.artifactPath = await persistEvidence(evidence.label, evidence);
    }
  }
});

test("six explicit process-crash boundaries are recorded as NOTRUN in this adapter harness", async () => {
  const evidence = {
    label: "six-crash-boundaries-not-run",
    protocol: "No process crash/power-loss simulation is claimed by this in-memory DataAdapter harness.",
    boundaries: [
      { label: "batch-temp-write-before-readback", status: "NOTRUN" },
      { label: "batch-rename-before-final-readback", status: "NOTRUN" },
      { label: "checkpoint-backup-write-before-readback", status: "NOTRUN" },
      { label: "checkpoint-primary-write-before-readback", status: "NOTRUN" },
      { label: "device-ack-write-before-readback", status: "NOTRUN" },
      { label: "gc-remove-before-existence-check", status: "NOTRUN" },
    ],
    reason: "These cases require process termination or durable-filesystem crash semantics; ordinary thrown adapter errors are not equivalent and were not substituted.",
  };
  evidence.artifactPath = await persistEvidence(evidence.label, evidence);
  assert.equal(evidence.boundaries.every(({ status }) => status === "NOTRUN"), true);
});
