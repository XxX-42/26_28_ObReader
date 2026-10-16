import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createCrashStore, createFileAdapter, hash } from "./store-process-crash-worker.mjs";

const thisFile = fileURLToPath(import.meta.url);
const workerFile = path.join(path.dirname(thisFile), "store-process-crash-worker.mjs");
const artifactDir = path.join(path.dirname(thisFile), "artifacts");
const storeRoot = "00_Archive/20_PDFData";

const cases = [
  {
    scenario: "pending-before-rename",
    boundary: "pending-before-rename",
    expectation: "The pending temp batch is not published; appendOperations had not acknowledged it.",
    assertState({ before, after, snapshot, paths }) {
      assert.ok(before.files.some((file) => file.endsWith(".pending")), "fsynced pending batch must remain on disk");
      assert.equal(before.files.includes(paths.batch), false, "rename must not have published the batch");
      assert.deepEqual(snapshot.annotations.map(({ uuid }) => uuid), [], "fresh C must not replay an unpublished batch");
      assert.equal(after.files.includes(paths.batch), false);
    },
  },
  {
    scenario: "operation-published-before-readback",
    boundary: "operation-published-before-readback",
    expectation: "The renamed immutable batch survives process death before append readback and is replayable by fresh C.",
    assertState({ before, snapshot }) {
      assert.ok(before.files.some((file) => file.endsWith("/batch-operation-published-before-readback.json")));
      assert.ok(snapshot.annotations.some(({ uuid }) => uuid === "annotation-operation-published-before-readback"));
    },
  },
  {
    scenario: "checkpoint-backup-written",
    boundary: "checkpoint-backup-written",
    expectation: "Primary revision 1 is committed before previous revision 0 rotation; fresh C recovers the newer state.",
    assertState({ before, snapshot }) {
      assert.equal(before.checkpointPair.primary.revision, 1);
      assert.equal(before.checkpointPair.backup.revision, 0);
      assert.ok(snapshot.annotations.some(({ uuid }) => uuid === "annotation-checkpoint-backup-written"));
    },
  },
  {
    scenario: "checkpoint-primary-written",
    boundary: "checkpoint-primary-written",
    expectation: "Primary write is on disk before readback; fresh C validates and recovers it.",
    assertState({ before, snapshot }) {
      assert.equal(before.checkpointPair.primary.revision, 1);
      assert.equal(before.checkpointPair.backup.revision, 0, "the prior verified baseline survives at the primary boundary");
      assert.notEqual(before.checkpointPair.backup.hash, before.checkpointPair.primary.hash);
      assert.ok(snapshot.annotations.some(({ uuid }) => uuid === "annotation-checkpoint-primary-written"));
    },
  },
  {
    scenario: "ack-before-write",
    boundary: "ack-before-write",
    expectation: "The worker is killed after both checkpoint copies are durable but before its first device ACK write; fresh C recovers without assuming that ACK exists.",
    assertState({ before, snapshot, paths }) {
      assert.equal(before.checkpointPair.primary.revision, 1);
      assert.equal(before.checkpointPair.backup.revision, 0);
      assert.notEqual(before.writerAck?.checkpointHash, before.checkpointPair.primary.hash,
        "the prior revision-0 ACK must not confirm revision 1");
      assert.ok(before.files.includes(paths.batch), "unacknowledged operation batch must remain on disk");
      assert.ok(snapshot.annotations.some(({ uuid }) => uuid === "annotation-ack-before-write"));
    },
  },
  {
    scenario: "ack-written-before-readback",
    boundary: "ack-written-before-readback",
    expectation: "Checkpoint copies and ACK bytes survive worker death before ACK readback; fresh C keeps the annotation.",
    assertState({ before, snapshot }) {
      assert.equal(before.checkpointPair.primary.revision, 1);
      assert.equal(before.checkpointPair.backup.revision, 0);
      assert.equal(before.writerAck?.checkpointHash, before.checkpointPair.primary.hash);
      assert.ok(snapshot.annotations.some(({ uuid }) => uuid === "annotation-ack-written-before-readback"));
    },
  },
  {
    scenario: "gc-remove-before-confirmation",
    boundary: "gc-remove-before-confirmation",
    expectation: "The actual covered-batch unlink survives worker death before exists confirmation; compact checkpoint retains the annotation.",
    assertState({ before, snapshot, paths }) {
      assert.equal(before.checkpointPair.primary.revision, 1);
      assert.equal(before.files.includes(paths.batch), false, "the adapter must have actually unlinked the batch before notification");
      assert.ok(snapshot.annotations.some(({ uuid }) => uuid === "annotation-gc-remove-before-confirmation"));
    },
  },
];

function summarizeCheckpoint(text) {
  if (!text) return null;
  try {
    const cp = JSON.parse(text);
    return {
      kind: cp.kind,
      revision: cp.revision,
      hash: cp.integrity,
      annotationUUIDs: Array.isArray(cp.annotations) ? cp.annotations.map(({ uuid }) => uuid).sort() : [],
      tombstoneUUIDs: Array.isArray(cp.tombstones) ? cp.tombstones.map(({ uuid }) => uuid).sort() : [],
    };
  } catch { return { invalidJson: true }; }
}

async function diskFiles(rootDirectory, relative = "") {
  const directory = path.join(rootDirectory, relative);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const result = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await diskFiles(rootDirectory, child));
    else if (entry.isFile()) result.push(child.replaceAll(path.sep, "/"));
  }
  return result.sort();
}

async function readIfExists(file) {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function inspectBeforeRecovery(rootDirectory, paths, writerId) {
  const diskRoot = path.join(rootDirectory, ...storeRoot.split("/"));
  const primary = await readIfExists(path.join(rootDirectory, ...paths.checkpoint.split("/")));
  const backup = await readIfExists(path.join(rootDirectory, ...paths.checkpointBackup.split("/")));
  const ackText = await readIfExists(path.join(rootDirectory, ...paths.deviceStates.split("/"), `${writerId}.json`));
  return {
    files: (await diskFiles(rootDirectory)).filter((file) => file.startsWith(`${storeRoot}/`)),
    checkpointPair: { primary: summarizeCheckpoint(primary), backup: summarizeCheckpoint(backup) },
    writerAck: ackText ? JSON.parse(ackText) : null,
    storeRootExists: await stat(diskRoot).then(() => true, () => false),
  };
}

function waitForBoundary(child, expected, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => finish(new Error(`worker boundary timeout: ${expected}`)), timeoutMs);
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error); else resolve(value);
    };
    const onMessage = (message) => {
      if (message?.type === "boundary" && message.boundary === expected) finish(null, message);
      else if (message?.type === "error") finish(new Error(`worker failed before boundary ${expected}: ${message.error}`));
    };
    const onExit = (code, signal) => finish(new Error(`worker exited before boundary ${expected}: code=${code} signal=${signal}`));
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function waitForExit(child, timeoutMs = 4000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("killed test worker did not exit within bound"));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once("exit", onExit);
  });
}

async function persistEvidence(evidence) {
  await mkdir(artifactDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const file = path.join(artifactDir, `store-process-crash-${evidence.scenario}-${stamp}-${process.pid}.json`);
  await import("node:fs/promises").then(({ writeFile }) => writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, "utf8"));
  return file;
}

for (const scenarioCase of cases) {
  test(`child-process crash boundary: ${scenarioCase.scenario}`, { timeout: 20000 }, async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pdf-annotation-crash-"));
    const sourcePath = `CrashTests/${scenarioCase.scenario}.pdf`;
    const documentId = `crash-document-${scenarioCase.scenario}`;
    const writerId = "crash-writer";
    const artifact = {
      scenario: scenarioCase.scenario,
      boundary: scenarioCase.boundary,
      expectation: scenarioCase.expectation,
      isolation: { tempDirectory: tempRoot, writerIsSeparateChildProcess: false, freshReaderDeviceId: `fresh-reader-${scenarioCase.scenario}` },
      status: "NOTVERIFIED",
      workerBoundaryMessage: null,
      processKill: null,
      beforeFreshStoreC: null,
      afterFreshStoreC: null,
    };
    let child;
    let storeC;
    let documentC;
    let artifactPath;
    try {
      child = fork(workerFile, [], {
        cwd: process.cwd(),
        silent: true,
        env: {
          ...process.env,
          STORE_CRASH_SCENARIO: scenarioCase.scenario,
          STORE_CRASH_ROOT: tempRoot,
          STORE_CRASH_SOURCE: sourcePath,
          STORE_CRASH_DOCUMENT_ID: documentId,
        },
      });
      const boundaryMessage = await waitForBoundary(child, scenarioCase.boundary);
      artifact.workerBoundaryMessage = boundaryMessage;
      artifact.isolation.writerChildPid = child.pid;
      artifact.isolation.writerIsSeparateChildProcess = child.pid !== process.pid;
      const requestedKill = child.kill("SIGKILL");
      const exit = await waitForExit(child);
      artifact.processKill = { requestedSignal: "SIGKILL", killReturned: requestedKill, exit };

      const adapterC = createFileAdapter(tempRoot);
      storeC = createCrashStore(adapterC, artifact.isolation.freshReaderDeviceId);
      documentC = await storeC.registerDocument({ sourcePath, documentId });
      const paths = storeC.pathsFor(documentC);
      artifact.paths = paths;
      const batchRelative = `${paths.operations}/${writerId}/${`batch-${scenarioCase.scenario}`}.json`;
      artifact.paths.batch = batchRelative;
      artifact.beforeFreshStoreC = await inspectBeforeRecovery(tempRoot, paths, writerId);
      const snapshot = await storeC.readDocument(documentC);
      artifact.snapshotFromFreshC = {
        revision: snapshot.revision,
        checkpointHash: snapshot.checkpointHash,
        annotationUUIDs: snapshot.annotations.map(({ uuid }) => uuid).sort(),
        tombstoneUUIDs: snapshot.tombstones.map(({ uuid }) => uuid).sort(),
      };
      artifact.afterFreshStoreC = await inspectBeforeRecovery(tempRoot, paths, writerId);
      artifact.status = "VERIFIED";
      artifactPath = await persistEvidence(artifact);
      artifact.artifactPath = artifactPath;

      assert.equal(artifact.isolation.writerIsSeparateChildProcess, true);
      assert.ok(artifact.processKill.killReturned, "test worker must be killed by parent after durable boundary IPC");
      assert.equal(artifact.processKill.exit.code, null, "worker must not exit normally after parent kill");
      assert.ok(artifact.processKill.exit.signal, "exit should report process termination signal");
      assert.equal(artifact.workerBoundaryMessage.boundary, scenarioCase.boundary);
      scenarioCase.assertState({
        before: artifact.beforeFreshStoreC,
        after: artifact.afterFreshStoreC,
        snapshot,
        paths: artifact.paths,
      });
    } catch (error) {
      artifact.status = artifact.workerBoundaryMessage ? "ASSERTION_FAILED" : "NOTVERIFIED";
      artifact.error = error?.stack || String(error);
      artifact.artifactPath = await persistEvidence(artifact);
      throw error;
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child).catch(() => {});
      }
      const resolvedTempRoot = path.resolve(tempRoot);
      assert.equal(path.dirname(resolvedTempRoot).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase(),
        "recursive cleanup must stay directly inside the intended temporary directory");
      assert.ok(path.basename(resolvedTempRoot).startsWith("pdf-annotation-crash-"),
        "recursive cleanup must target only this test's mkdtemp directory");
      await rm(resolvedTempRoot, { recursive: true, force: true });
    }
  });
}
