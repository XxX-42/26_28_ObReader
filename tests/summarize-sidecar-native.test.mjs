import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const summarizerPath = path.join(testsDirectory, "summarize-sidecar-native.mjs");

function syntheticRun(scenario, timingTrace = {}, driverSourceHashReads = undefined) {
  const benchmark = Array.from({ length: 10 }, (_, index) => ({
    edit: index + 1,
    heap: { usedSize: 1000 + index },
  }));
  const messages = benchmark.map(({ edit }) => ({
    type: "save",
    at: edit * 100,
    requestId: `${scenario}-request-${edit}`,
    revision: edit,
    operations: edit,
    encodedBytes: edit * 20,
  }));
  const acks = messages.map((message, index) => ({
    type: "saved",
    ok: true,
    external: true,
    at: message.at + 5,
    requestId: message.requestId,
    revision: message.revision,
    operationCount: index + 1,
    batchId: `${scenario}-batch-${index + 1}`,
  }));
  return {
    status: "passed",
    scenario,
    version: "0.7.1",
    fixture: "synthetic-fixture.pdf",
    stages: benchmark.map(({ edit }) => ({
      label: `benchmark-${edit}`,
      state: { docKey: "synthetic-document" },
    })),
    benchmark,
    trace: {
      messages,
      acks,
      io: [],
      sourceWriteAttempts: [],
      pdfSerializations: [],
      ...timingTrace,
    },
    ...(driverSourceHashReads === undefined ? {} : { driverSourceHashReads }),
  };
}

test("synthetic timing traces report phase distributions and keep missing/error/blocked measurements distinct", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-summary-synthetic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const smallPath = path.join(directory, "0.7-sidecar-native-acceptance-synthetic-small.json");
  const largePath = path.join(directory, "0.7-sidecar-native-acceptance-synthetic-large.json");
  await writeFile(smallPath, JSON.stringify(syntheticRun("benchmark-small", {
    viewerTimings: [
      { phase: "capture", documentId: "synthetic-document", openRequest: 1, rendererGeneration: 1, status: "ok", durationMs: 10, revision: 1, operationCount: 1, rowCount: 3, startedAtEpochMs: 1000 },
      { phase: "capture", documentId: "synthetic-document", openRequest: 1, rendererGeneration: 1, status: "ok", durationMs: 12, revision: 1, operationCount: 0, rowCount: 3, startedAtEpochMs: 1010 },
      { phase: "capture", documentId: "synthetic-document", openRequest: 1, rendererGeneration: 1, status: "error", durationMs: 30, revision: 2, operationCount: 2, rowCount: 3, startedAtEpochMs: 1020 },
      { phase: "encode", documentId: "synthetic-document", openRequest: 1, rendererGeneration: 1, status: "ok", durationMs: 2, revision: 1, operationCount: 1, rowCount: 0, startedAtEpochMs: 1000 },
      { phase: "encode", documentId: "synthetic-document", openRequest: 1, rendererGeneration: 1, status: "ok", durationMs: 4, revision: 2, operationCount: 2, rowCount: 0, startedAtEpochMs: 1010 },
    ],
    storeTimings: [
      { event: "annotation-performance", phase: "gc", docKey: "synthetic-document", revision: 4, status: "success", durationMs: 7, queueWaitMs: 3, materializationQueueWaitMs: 5, eligible: true, blocked: false, candidateBatchCount: 3, candidateBatchBytes: 300, removedBatchCount: 2, removedBatchBytes: 200, startedAtEpochMs: 1000, startedAtMonotonicMs: 500 },
      { event: "annotation-performance", phase: "gc", docKey: "synthetic-document", revision: 5, status: "blocked", durationMs: 9, queueWaitMs: 6, materializationQueueWaitMs: 2, eligible: false, blocked: true, candidateBatchCount: 0, candidateBatchBytes: 0, removedBatchCount: 0, removedBatchBytes: 0 },
      { event: "annotation-performance", phase: "gc", docKey: "synthetic-document", revision: 6, status: "error", durationMs: 11, queueWaitMs: 9, materializationQueueWaitMs: 1, eligible: true, blocked: false, candidateBatchCount: 1, candidateBatchBytes: 80, removedBatchCount: 0, removedBatchBytes: 0, errorCode: "PDF_ANNOTATION_GC_UNCONFIRMED" },
    ],
  }, [
    { label: "before-open", bytes: 4096, readAndHashMs: 5.2 },
    { label: "after-reopen", bytes: 4096, readAndHashMs: 4.8 },
  ])));
  await writeFile(largePath, JSON.stringify(syntheticRun("benchmark-large")));

  const result = spawnSync(process.execPath, [
    summarizerPath,
    smallPath,
    largePath,
    "--stdout",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const marker = "===== JSON =====\n";
  const jsonStart = result.stdout.lastIndexOf(marker);
  assert.notEqual(jsonStart, -1, "summarizer stdout should include its JSON report");
  const report = JSON.parse(result.stdout.slice(jsonStart + marker.length).trim());

  assert.equal(report.status, "complete", "both synthetic acceptance inputs contain ten durable saved ACKs");
  const small = report.scenarios["benchmark-small"];
  assert.equal(small.successfulSampleCount, 10);
  assert.equal(small.successfulRuns[0].io.driverSourceHashReadCount, 2,
    "each Native driver hash probe is counted separately from product readBinary events");
  assert.equal(small.successfulRuns[0].io.driverSourceHashReadBytes, 8192);
  assert.deepEqual(small.runMetrics.driverSourceHashReadCount, {
    count: 1, mean: 2, median: 2, p90: 2, max: 2,
  });
  assert.deepEqual(small.runMetrics.driverSourceHashReadBytesTotal, {
    count: 1, mean: 8192, median: 8192, p90: 8192, max: 8192,
  });
  assert.deepEqual(small.runMetrics.driverSourceHashReadByteObservationCount, {
    count: 1, mean: 2, median: 2, p90: 2, max: 2,
  });
  assert.equal(small.runMetrics.driverSourceHashReadTracePresentRuns, 1);
  const large = report.scenarios["benchmark-large"];
  assert.equal(large.successfulRuns[0].io.driverSourceHashReadCount, null,
    "a missing driverSourceHashReads field must remain missing rather than be inferred as zero");
  assert.equal(large.successfulRuns[0].io.driverSourceHashReadBytes, null);
  assert.equal(large.runMetrics.driverSourceHashReadCount.count, 0);
  assert.equal(large.runMetrics.driverSourceHashReadCount.mean, null);
  assert.equal(large.runMetrics.driverSourceHashReadBytesTotal.count, 0);
  assert.equal(large.runMetrics.driverSourceHashReadBytesTotal.mean, null);
  assert.equal(large.runMetrics.driverSourceHashReadTraceMissingRuns, 1);
  assert.match(report.observability.driverSourceHashReads, /OBSERVED \(1\/2 input\(s\)/);
  assert.match(report.observability.driverSourceHashReadSemantics, /not a complete application I\/O accounting/);
  assert.match(report.observability.driverSourceHashReadSemantics, /sidecar-tree reads can perturb background GC/);
  assert.deepEqual(small.phaseTimings.capture.byStatus.success.durationMs, {
    count: 2, mean: 11, median: 11, p90: 12, max: 12,
  });
  assert.equal(small.phaseTimings.capture.byStatus.error.durationMs.mean, 30);
  assert.equal(small.phaseTimings.capture.byStatus.success.noOperationEvents, 1);
  assert.equal(small.phaseTimings.capture.byStatus.success.operationCountObservationCount, 2);
  assert.deepEqual(small.phaseTimings.capture.byStatus.success.rowCount, {
    count: 2, mean: 3, median: 3, p90: 3, max: 3,
  });
  assert.match(report.observability.annotationCaptureTimingSemantics, /operationCount=0 events are no-op invocations/);
  assert.deepEqual(small.phaseTimings.encode.byStatus.success.durationMs, {
    count: 2, mean: 3, median: 3, p90: 4, max: 4,
  });
  assert.deepEqual(small.phaseTimings.gc.byStatus.success.removedBatchCount, {
    count: 1, mean: 2, median: 2, p90: 2, max: 2,
  });
  assert.deepEqual(small.phaseTimings.gc.byStatus.success.durationMs, {
    count: 1, mean: 7, median: 7, p90: 7, max: 7,
  });
  assert.deepEqual(small.phaseTimings.gc.byStatus.success.queueWaitMs, {
    count: 1, mean: 3, median: 3, p90: 3, max: 3,
  }, "GC queue wait is independently summarized rather than included in durationMs");
  assert.deepEqual(small.phaseTimings.gc.byStatus.success.materializationQueueWaitMs, {
    count: 1, mean: 5, median: 5, p90: 5, max: 5,
  }, "materialization queue wait is distinct from GC queue wait and execution duration");
  assert.equal(small.phaseTimings.gc.byStatus.success.removedBatchBytes.mean, 200);
  assert.equal(small.phaseTimings.gc.byStatus.success.candidateBatchCount.mean, 3);
  assert.equal(small.phaseTimings.gc.byStatus.success.eligibleTrueEvents, 1);
  assert.equal(small.phaseTimings.gc.byStatus.success.eligibleFalseEvents, 0);
  assert.equal(small.phaseTimings.gc.byStatus.blocked.eligibleFalseEvents, 1);
  assert.equal(small.phaseTimings.gc.byStatus.blocked.blockedEvents, 1);
  assert.equal(small.phaseTimings.gc.byStatus.error.statuses[0], "error");
  assert.equal(small.phaseTimings.gc.byStatus.error.eventCount, 1);

  const largeCapture = report.scenarios["benchmark-large"].phaseTimings.capture.byStatus.success.durationMs;
  assert.equal(largeCapture.count, 0);
  assert.equal(largeCapture.mean, null, "missing metrics must not be reported as zero duration");
  const largeGcQueueWait = report.scenarios["benchmark-large"].phaseTimings.gc.byStatus.success.queueWaitMs;
  assert.equal(largeGcQueueWait.count, 0);
  assert.equal(largeGcQueueWait.mean, null, "missing queueWaitMs remains NOT OBSERVABLE, not zero");
  const largeMaterializationWait = report.scenarios["benchmark-large"].phaseTimings.gc.byStatus.success.materializationQueueWaitMs;
  assert.equal(largeMaterializationWait.count, 0);
  assert.equal(largeMaterializationWait.mean, null,
    "missing materializationQueueWaitMs remains NOT OBSERVABLE, not zero");
  assert.match(report.observability.garbageCollectionQueueWaitDuration, /OBSERVED \(3 numeric queueWaitMs event\(s\)/);
  assert.match(report.observability.garbageCollectionMaterializationQueueWaitDuration,
    /OBSERVED \(3 numeric materializationQueueWaitMs event\(s\)/);
  assert.equal(report.observability.operationReplayDuration,
    "NOT OBSERVABLE (the input trace contains no duration/counter for this phase)");
  assert.match(report.inputs[0].input, /synthetic-small\.json$/,
    "the validated evidence must remain explicitly identified as synthetic");
  assert.match(result.stdout, /GC duration may include its own checkpoint backup work/);
  assert.match(result.stdout, /queueWaitMs measures time waiting for the GC execution queue/);
  assert.match(result.stdout, /materializationQueueWaitMs measures time waiting for materialization serialization/);
  assert.match(result.stdout, /Materialization queue wait is not operation replay duration, which remains NOT OBSERVABLE/);
  assert.match(result.stdout, /not a per-user-edit cost/);
  assert.match(result.stdout, /Native driver source-hash probe reads/);
  assert.match(result.stdout, /NOT OBSERVABLE, not inferred as zero/);
  assert.match(result.stdout, /not a complete application I\/O accounting/);
  assert.match(result.stdout, /sidecar-tree reads can perturb background GC/);
  assert.match(result.stdout, /NOT OBSERVABLE/);
});
