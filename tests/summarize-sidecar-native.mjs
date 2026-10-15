#!/usr/bin/env node

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactName = /^0\.7-sidecar-native-acceptance-.+\.json$/i;
const expectedEdits = Array.from({ length: 10 }, (_, index) => index + 1);
const writeNames = new Set(["write", "writeBinary", "append", "appendBinary"]);
const notObservable = "NOT OBSERVABLE (the input trace contains no duration/counter for this phase)";

function parseArgs(argv) {
  const inputs = [];
  let outputPrefix = null;
  let stdout = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") return { help: true };
    if (value === "--stdout") {
      stdout = true;
      continue;
    }
    if (value === "--output-prefix" || value === "--out-prefix") {
      outputPrefix = argv[index + 1];
      if (!outputPrefix || outputPrefix.startsWith("--")) {
        throw new Error(`${value} requires a path prefix (without .md/.json).`);
      }
      index += 1;
      continue;
    }
    if (value.startsWith("--")) throw new Error(`Unknown option: ${value}`);
    inputs.push(value);
  }
  if (stdout && outputPrefix) throw new Error("Use either --stdout or --output-prefix, not both.");
  if (!inputs.length) throw new Error("Pass one or more explicit 0.7-sidecar-native-acceptance-*.json paths.");
  return { inputs, outputPrefix, stdout, help: false };
}

function normalizePath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/\/{2,}/g, "/");
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stats(values) {
  const sorted = values.map(finite).filter((value) => value !== null).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, mean: null, median: null, p90: null, max: null };
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    // Nearest-rank percentile: rank = ceil(0.90 * n), one-based.
    p90: sorted[Math.ceil(0.9 * sorted.length) - 1],
    max: sorted.at(-1),
  };
}

function duration(event) {
  return finite(event?.ms);
}

function bytes(event) {
  return finite(event?.bytes);
}

function metricStats(rows, getter) {
  return stats(rows.map(getter));
}

const timingStatusClasses = ["success", "error", "blocked", "other"];

function timingStatusClass(value) {
  const status = String(value ?? "unspecified").trim().toLowerCase();
  if (["ok", "success", "succeeded", "complete", "completed"].includes(status)) return "success";
  if (["error", "failed", "failure"].includes(status)) return "error";
  if (status === "blocked") return "blocked";
  return "other";
}

function normalizePhaseTiming(event, phase) {
  return {
    phase,
    status: event?.status == null ? "unspecified" : String(event.status),
    statusClass: timingStatusClass(event?.status),
    durationMs: finite(event?.durationMs),
    queueWaitMs: finite(event?.queueWaitMs),
    materializationQueueWaitMs: finite(event?.materializationQueueWaitMs),
    at: finite(event?.at),
    revision: finite(event?.revision),
    operationCount: finite(event?.operationCount),
    rowCount: finite(event?.rowCount),
    eligible: typeof event?.eligible === "boolean" ? event.eligible : null,
    blocked: typeof event?.blocked === "boolean" ? event.blocked : null,
    candidateBatchCount: finite(event?.candidateBatchCount),
    candidateBatchBytes: finite(event?.candidateBatchBytes),
    removedBatchCount: finite(event?.removedBatchCount),
    removedBatchBytes: finite(event?.removedBatchBytes),
    docKey: typeof event?.docKey === "string" ? event.docKey : null,
    errorCode: typeof event?.errorCode === "string" ? event.errorCode : null,
  };
}

function phaseTimingsFromTrace(trace) {
  const viewer = Array.isArray(trace?.viewerTimings) ? trace.viewerTimings : [];
  const store = Array.isArray(trace?.storeTimings) ? trace.storeTimings : [];
  return {
    capture: viewer.filter((event) => event?.phase === "capture")
      .map((event) => normalizePhaseTiming(event, "capture")),
    encode: viewer.filter((event) => event?.phase === "encode")
      .map((event) => normalizePhaseTiming(event, "encode")),
    gc: store.filter((event) => event?.event === "annotation-performance" && event?.phase === "gc")
      .map((event) => normalizePhaseTiming(event, "gc")),
  };
}

function summarizePhaseTimings(records) {
  const byStatus = Object.fromEntries(timingStatusClasses.map((statusClass) => {
    const rows = records.filter((row) => row.statusClass === statusClass);
    return [statusClass, {
      eventCount: rows.length,
      durationMs: stats(rows.map((row) => row.durationMs)),
      queueWaitMs: stats(rows.map((row) => row.queueWaitMs)),
      queueWaitObservationCount: rows.filter((row) => finite(row.queueWaitMs) !== null).length,
      materializationQueueWaitMs: stats(rows.map((row) => row.materializationQueueWaitMs)),
      materializationQueueWaitObservationCount: rows.filter((row) => finite(row.materializationQueueWaitMs) !== null).length,
      operationCount: stats(rows.map((row) => row.operationCount)),
      operationCountObservationCount: rows.filter((row) => finite(row.operationCount) !== null).length,
      rowCount: stats(rows.map((row) => row.rowCount)),
      candidateBatchCount: stats(rows.map((row) => row.candidateBatchCount)),
      candidateBatchBytes: stats(rows.map((row) => row.candidateBatchBytes)),
      removedBatchCount: stats(rows.map((row) => row.removedBatchCount)),
      removedBatchBytes: stats(rows.map((row) => row.removedBatchBytes)),
      eligibilityObservationCount: rows.filter((row) => row.eligible !== null).length,
      eligibleTrueEvents: rows.filter((row) => row.eligible === true).length,
      eligibleFalseEvents: rows.filter((row) => row.eligible === false).length,
      blockedObservationCount: rows.filter((row) => row.blocked !== null).length,
      blockedEvents: rows.filter((row) => row.blocked === true).length,
      noOperationEvents: rows.filter((row) => row.operationCount === 0).length,
      positiveOperationEvents: rows.filter((row) => row.operationCount > 0).length,
      statuses: [...new Set(rows.map((row) => row.status))].sort(),
    }];
  }));
  return {
    eventCount: records.length,
    durationObservationCount: records.filter((row) => finite(row.durationMs) !== null).length,
    missingDurationCount: records.filter((row) => finite(row.durationMs) === null).length,
    byStatus,
  };
}

function phaseObservability(runs, phase, metric = "durationMs") {
  const records = runs.flatMap((run) => run.phaseTimings[phase] ?? []);
  const observed = records.filter((row) => finite(row[metric]) !== null).length;
  return observed
    ? `OBSERVED (${observed} numeric ${metric} event(s); see status-separated phase statistics)`
    : notObservable;
}

function metricRow(events, predicate) {
  const found = events.find(predicate);
  return found ? { at: finite(found.at), ms: duration(found), bytes: bytes(found), path: found.path ?? null } : null;
}

function errorSummary(value) {
  if (!value) return null;
  const firstLine = String(value).split(/\r?\n/, 1)[0].trim();
  return firstLine.length > 300 ? `${firstLine.slice(0, 297)}...` : firstLine;
}

function ordered(items) {
  return [...(Array.isArray(items) ? items : [])]
    .sort((left, right) => (finite(left?.at) ?? Number.POSITIVE_INFINITY) -
      (finite(right?.at) ?? Number.POSITIVE_INFINITY));
}

function matchAck(message, acks, usedAckIndexes) {
  if (!message?.requestId) return null;
  const matches = acks.map((ack, index) => ({ ack, index })).filter(({ ack, index }) =>
    !usedAckIndexes.has(index) && ack?.requestId === message.requestId &&
    (finite(message.at) === null || finite(ack.at) === null || ack.at >= message.at) &&
    (finite(message.revision) === null || finite(ack.revision) === null || ack.revision === message.revision));
  const selected = matches.find(({ ack }) => ack.type === "saved" && ack.ok === true &&
    ack.external === true && finite(ack.operationCount) > 0 && typeof ack.batchId === "string" && ack.batchId.length > 0) ??
    matches.find(({ ack }) => ack.type === "saved" && ack.ok === true) ??
    matches.find(({ ack }) => ack.type === "error") ?? matches[0];
  if (!selected) return null;
  usedAckIndexes.add(selected.index);
  return selected.ack;
}

function eventsInWindow(events, start, end) {
  if (finite(start) === null || finite(end) === null || end < start) return [];
  return events.filter((event) => finite(event?.at) !== null && event.at >= start && event.at <= end);
}

function batchTimings(io, message, ack) {
  const batchId = ack?.batchId;
  const window = eventsInWindow(io, message?.at, ack?.at);
  if (!batchId) {
    return {
      batchId: null,
      pendingWrite: null,
      pendingReadback: null,
      publishRename: null,
      finalJsonReadback: null,
      finalJsonDirectWrite: null,
    };
  }

  const batchMarker = `/${batchId}.json`;
  const pendingWrite = metricRow(window, (event) => event.name === "write" &&
    String(event.path).includes(batchMarker) && String(event.path).endsWith(".pending"));
  const pendingPath = pendingWrite?.path;
  const pendingReadback = pendingPath
    ? metricRow(window, (event) => event.name === "read" && event.path === pendingPath)
    : null;
  const publishRename = pendingPath
    ? metricRow(window, (event) => event.name === "rename" && event.path === pendingPath)
    : null;
  const finalPath = `${batchMarker}`;
  const finalJsonReadback = metricRow(window, (event) => event.name === "read" &&
    String(event.path).endsWith(finalPath));
  const finalJsonDirectWrite = metricRow(window, (event) => event.name === "write" &&
    String(event.path).endsWith(finalPath));
  return { batchId, pendingWrite, pendingReadback, publishRename, finalJsonReadback, finalJsonDirectWrite };
}

function makeSample({ edit, message, ack, benchmark, stage, io }) {
  const ackLatencyMs = message && ack?.type === "saved" && ack.ok === true &&
    finite(message.at) !== null && finite(ack.at) !== null ? ack.at - message.at : null;
  const responseLatencyMs = message && ack && finite(message.at) !== null && finite(ack.at) !== null
    ? ack.at - message.at : null;
  const throughAck = eventsInWindow(io, message?.at, ack?.at);
  const writeEvents = throughAck.filter((event) => writeNames.has(event.name));
  const readBinaryEvents = throughAck.filter((event) => event.name === "readBinary");
  const heap = benchmark?.heap && typeof benchmark.heap === "object" ? benchmark.heap : null;
  const durableSavedAck = ack?.type === "saved" && ack.ok === true && ack.external === true &&
    finite(ack.operationCount) > 0 && typeof ack.batchId === "string" && ack.batchId.length > 0;
  return {
    edit,
    status: durableSavedAck ? "durable-saved-ack" : ack?.type === "error" ? "error-ack" :
      ack?.type === "saved" ? "saved-ack-not-confirmed-external" : "no-saved-ack",
    requestId: message?.requestId ?? null,
    revision: message?.revision ?? ack?.revision ?? null,
    messageAt: finite(message?.at),
    ackAt: finite(ack?.at),
    ackLatencyMs,
    responseLatencyMs,
    operations: finite(message?.operations),
    externalAck: ack?.external === true,
    acknowledgedOperationCount: finite(ack?.operationCount),
    messageEncodedBytes: finite(message?.encodedBytes),
    batch: batchTimings(io, message, ack),
    ioBetweenSendAndAck: {
      writeBytes: writeEvents.reduce((sum, event) => sum + (bytes(event) ?? 0), 0),
      writeEvents: writeEvents.length,
      readBinaryBytes: readBinaryEvents.reduce((sum, event) => sum + (bytes(event) ?? 0), 0),
      readBinaryEvents: readBinaryEvents.length,
    },
    checkpointRevision: finite(benchmark?.checkpointRevision ?? stage?.checkpoint?.revision),
    checkpointBytes: finite(benchmark?.checkpointBytes ?? stage?.checkpoint?.checkpointBytes),
    heap,
  };
}

function getDocKey(run) {
  for (const stage of run.stages ?? []) {
    if (stage?.state?.docKey) return stage.state.docKey;
  }
  return run.benchmark?.find((item) => item?.state?.docKey)?.state?.docKey ?? null;
}

function checkpointMetrics(run, io) {
  const docKey = getDocKey(run);
  if (!docKey) return { docKey: null, primary: [], backup: [] };
  const prefix = `00_Archive/20_PDFData/checkpoints/${docKey}`;
  const writes = io.filter((event) => event.name === "write");
  return {
    docKey,
    primary: writes.filter((event) => normalizePath(event.path) === `${prefix}.json`)
      .map((event) => ({ at: finite(event.at), ms: duration(event), bytes: bytes(event) })),
    backup: writes.filter((event) => normalizePath(event.path) === `${prefix}.previous.json`)
      .map((event) => ({ at: finite(event.at), ms: duration(event), bytes: bytes(event) })),
  };
}

function summarizeRun(inputPath, data) {
  const trace = data?.trace && typeof data.trace === "object" ? data.trace : {};
  const phaseTimings = phaseTimingsFromTrace(trace);
  const messages = ordered(trace.messages).filter((message) => message.type === "save");
  const acks = ordered(trace.acks);
  const benchmark = Array.isArray(data?.benchmark) ? [...data.benchmark].sort((a, b) =>
    (finite(a?.edit) ?? 0) - (finite(b?.edit) ?? 0)) : [];
  const stageMap = new Map((Array.isArray(data?.stages) ? data.stages : []).map((stage) => [stage?.label, stage]));
  const benchmarkLabels = [...stageMap.keys()].filter((label) => /^benchmark-\d+$/.test(String(label)))
    .sort((a, b) => Number(a.slice("benchmark-".length)) - Number(b.slice("benchmark-".length)));
  const count = Math.max(messages.length, benchmark.length, benchmarkLabels.length);
  const usedAckIndexes = new Set();
  const io = Array.isArray(trace.io) ? ordered(trace.io) : [];
  const samples = Array.from({ length: count }, (_, index) => {
    const bench = benchmark[index] ?? null;
    const stage = stageMap.get(`benchmark-${bench?.edit ?? index + 1}`) ?? stageMap.get(benchmarkLabels[index]);
    const message = messages[index] ?? null;
    const ack = matchAck(message, acks, usedAckIndexes);
    return makeSample({ edit: finite(bench?.edit) ?? index + 1, message, ack, benchmark: bench, stage, io });
  });
  const fullEdits = benchmark.map((item) => finite(item?.edit)).sort((a, b) => a - b);
  const allSamplesAcked = samples.length === 10 && samples.every((sample) => sample.status === "durable-saved-ack");
  const hasTenStages = benchmarkLabels.length === 10 && expectedEdits.every((edit, index) =>
    Number(benchmarkLabels[index]?.slice("benchmark-".length)) === edit);
  const hasTenBenchmarkRows = benchmark.length === 10 && fullEdits.length === 10 &&
    expectedEdits.every((edit, index) => fullEdits[index] === edit);
  const readBinary = io.filter((event) => event.name === "readBinary");
  const fixturePath = normalizePath(data?.fixture);
  const sourceReads = readBinary.filter((event) => normalizePath(event.path) === fixturePath);
  const writeEvents = io.filter((event) => writeNames.has(event.name));
  const checkpoint = checkpointMetrics(data, io);
  const heapKeys = [...new Set(samples.flatMap((sample) => Object.keys(sample.heap ?? {})))].sort();
  const driverHashReads = Array.isArray(data?.driverSourceHashReads) ? data.driverSourceHashReads : null;
  const driverHashReadByteValues = driverHashReads?.map((event) => finite(event?.bytes)) ?? null;
  const driverHashReadBytesComplete = driverHashReadByteValues !== null &&
    driverHashReadByteValues.every((value) => value !== null);
  const sourceWriteAttempts = Array.isArray(trace.sourceWriteAttempts) ? trace.sourceWriteAttempts : null;
  const pdfSerializations = Array.isArray(trace.pdfSerializations) ? trace.pdfSerializations : null;
  const sourceIntegrityTraceSafe = sourceWriteAttempts !== null && sourceWriteAttempts.length === 0;
  const noPdfSerialization = pdfSerializations !== null && pdfSerializations.length === 0;
  const complete = data?.status === "passed" && /^benchmark-(small|large)$/.test(String(data?.scenario)) &&
    hasTenStages && hasTenBenchmarkRows && messages.length === 10 && allSamplesAcked &&
    sourceIntegrityTraceSafe && noPdfSerialization;
  return {
    input: path.relative(root, inputPath).replaceAll("\\", "/"),
    scenario: data?.scenario ?? "unknown",
    version: data?.version ?? null,
    status: data?.status ?? "unknown",
    completeTenSampleRun: complete,
    completionReasons: complete ? [] : [
      ...(data?.status !== "passed" ? [`input status is ${data?.status ?? "missing"}`] : []),
      ...(!/^benchmark-(small|large)$/.test(String(data?.scenario)) ? ["scenario is not benchmark-small or benchmark-large"] : []),
      ...(benchmark.length !== 10 ? [`benchmark rows ${benchmark.length}/10`] : []),
      ...(messages.length !== 10 ? [`save messages ${messages.length}/10`] : []),
      ...(samples.filter((sample) => sample.status === "durable-saved-ack").length !== 10 ?
        [`matching durable external saved ACKs ${samples.filter((sample) => sample.status === "durable-saved-ack").length}/10`] : []),
      ...(benchmarkLabels.length !== 10 ? [`benchmark stages ${benchmarkLabels.length}/10`] : []),
      ...(!hasTenStages && benchmarkLabels.length === 10 ? ["benchmark stage labels are not exactly benchmark-1..benchmark-10"] : []),
      ...(hasTenBenchmarkRows === false && benchmark.length === 10 ? ["benchmark edit indices are not exactly 1..10"] : []),
      ...(!sourceIntegrityTraceSafe ? [sourceWriteAttempts === null ? "source-write trace missing" : `source-PDF write attempts ${sourceWriteAttempts.length}`] : []),
      ...(!noPdfSerialization ? [pdfSerializations === null ? "PDF serialization trace missing" : `Viewer PDF serialization calls ${pdfSerializations.length}`] : []),
    ],
    observedIterations: count,
    successfulSavedAcks: samples.filter((sample) => sample.status === "durable-saved-ack").length,
    error: errorSummary(data?.error),
    samples,
    phaseTimings,
    io: {
      adapterWriteBytes: writeEvents.reduce((sum, event) => sum + (bytes(event) ?? 0), 0),
      adapterWriteEvents: writeEvents.length,
      readBinaryBytes: readBinary.reduce((sum, event) => sum + (bytes(event) ?? 0), 0),
      readBinaryEvents: readBinary.length,
      sourcePdfReadBinaryBytes: sourceReads.reduce((sum, event) => sum + (bytes(event) ?? 0), 0),
      sourcePdfReadBinaryEvents: sourceReads.length,
      driverSourceHashReadCount: driverHashReads?.length ?? null,
      driverSourceHashReadBytes: driverHashReadBytesComplete
        ? driverHashReadByteValues.reduce((sum, value) => sum + value, 0)
        : null,
      driverSourceHashReadByteObservationCount: driverHashReadByteValues?.filter((value) => value !== null).length ?? null,
      sourceWriteAttempts: sourceWriteAttempts?.length ?? null,
      pdfSerializationCalls: pdfSerializations?.length ?? null,
    },
    checkpoint,
    memory: Object.fromEntries(heapKeys.map((key) => [key,
      stats(samples.map((sample) => finite(sample.heap?.[key])))])),
  };
}

function scenarioSummary(name, runs) {
  const matching = runs.filter((run) => run.scenario === name);
  const completeRuns = matching.filter((run) => run.completeTenSampleRun);
  const incompleteRuns = matching.filter((run) => !run.completeTenSampleRun);
  const successfulSamples = completeRuns.flatMap((run) => run.samples);
  const rows = successfulSamples;
  const phaseTimings = Object.fromEntries(["capture", "encode", "gc"].map((phase) => {
    const records = completeRuns.flatMap((run) => run.phaseTimings[phase] ?? []);
    return [phase, summarizePhaseTimings(records)];
  }));
  const metrics = {
    ackLatencyMs: metricStats(rows, (row) => row.ackLatencyMs),
    operationPendingWriteMs: metricStats(rows, (row) => row.batch.pendingWrite?.ms),
    operationPendingWriteBytes: metricStats(rows, (row) => row.batch.pendingWrite?.bytes),
    operationPendingReadbackMs: metricStats(rows, (row) => row.batch.pendingReadback?.ms),
    operationPublishRenameMs: metricStats(rows, (row) => row.batch.publishRename?.ms),
    operationFinalJsonReadbackMs: metricStats(rows, (row) => row.batch.finalJsonReadback?.ms),
    operationFinalJsonDirectWriteMs: metricStats(rows, (row) => row.batch.finalJsonDirectWrite?.ms),
    adapterWriteBytesBeforeAck: metricStats(rows, (row) => row.ioBetweenSendAndAck.writeBytes),
    readBinaryBytesBeforeAck: metricStats(rows, (row) => row.ioBetweenSendAndAck.readBinaryBytes),
    messageEncodedBytes: metricStats(rows, (row) => row.messageEncodedBytes),
    checkpointBytes: metricStats(rows, (row) => row.checkpointBytes),
  };
  const allCheckpointPrimary = completeRuns.flatMap((run) => run.checkpoint.primary);
  const allCheckpointBackup = completeRuns.flatMap((run) => run.checkpoint.backup);
  const runMetrics = {
    adapterWriteBytesTotal: stats(completeRuns.map((run) => run.io.adapterWriteBytes)),
    readBinaryBytesTotal: stats(completeRuns.map((run) => run.io.readBinaryBytes)),
    sourcePdfReadBinaryBytesTotal: stats(completeRuns.map((run) => run.io.sourcePdfReadBinaryBytes)),
    driverSourceHashReadCount: stats(completeRuns.map((run) => run.io.driverSourceHashReadCount)),
    driverSourceHashReadBytesTotal: stats(completeRuns.map((run) => run.io.driverSourceHashReadBytes)),
    sourceWriteAttempts: stats(completeRuns.map((run) => run.io.sourceWriteAttempts)),
    pdfSerializationCalls: stats(completeRuns.map((run) => run.io.pdfSerializationCalls)),
    checkpointPrimaryWriteMs: stats(allCheckpointPrimary.map((event) => event.ms)),
    checkpointPrimaryWriteBytes: stats(allCheckpointPrimary.map((event) => event.bytes)),
    checkpointBackupWriteMs: stats(allCheckpointBackup.map((event) => event.ms)),
    checkpointBackupWriteBytes: stats(allCheckpointBackup.map((event) => event.bytes)),
    driverSourceHashReadTracePresentRuns: completeRuns.filter((run) => run.io.driverSourceHashReadCount !== null).length,
    driverSourceHashReadTraceMissingRuns: completeRuns.filter((run) => run.io.driverSourceHashReadCount === null).length,
    driverSourceHashReadByteObservationCount: stats(completeRuns.map((run) =>
      run.io.driverSourceHashReadByteObservationCount)),
  };
  const memoryKeys = [...new Set(completeRuns.flatMap((run) => Object.keys(run.memory)))].sort();
  const memory = Object.fromEntries(memoryKeys.map((key) => {
    const stageValues = completeRuns.flatMap((run) => run.samples.map((sample) => finite(sample.heap?.[key])));
    return [key, stats(stageValues)];
  }));
  const successfulSampleCount = successfulSamples.length;
  return {
    scenario: name,
    expectedSamplesPerSuccessfulRun: 10,
    matchingInputCount: matching.length,
    successfulCompleteRuns: completeRuns.length,
    successfulSampleCount,
    exactlyTenSuccessfulSamples: completeRuns.length === 1 && successfulSampleCount === 10,
    hasCompleteSuccessfulRun: completeRuns.length > 0,
    allMatchingInputsComplete: matching.length > 0 && incompleteRuns.length === 0,
    successfulRuns: completeRuns,
    incompleteAttempts: incompleteRuns.map((run) => ({
      input: run.input,
      status: run.status,
      observedIterations: run.observedIterations,
      successfulSavedAcks: run.successfulSavedAcks,
      completionReasons: run.completionReasons,
      error: run.error,
      partialSamples: run.samples,
      phaseTimings: run.phaseTimings,
    })),
    metrics,
    phaseTimings,
    runMetrics,
    memory,
  };
}

function formatNumber(value, digits = 2) {
  return finite(value) === null ? "NOT OBSERVABLE" : value.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

function formatStats(value, unit = "ms") {
  if (!value || value.count === 0) return "NOT OBSERVABLE (n=0)";
  return `mean ${formatNumber(value.mean)} ${unit}; median ${formatNumber(value.median)}; P90 ${formatNumber(value.p90)}; max ${formatNumber(value.max)}; n=${value.count}`;
}

function batchCell(batch) {
  return [
    `pending write ${formatNumber(batch.pendingWrite?.ms)} ms / ${formatNumber(batch.pendingWrite?.bytes, 0)} B`,
    `pending read ${formatNumber(batch.pendingReadback?.ms)} ms`,
    `publish rename ${formatNumber(batch.publishRename?.ms)} ms`,
    `final JSON read ${formatNumber(batch.finalJsonReadback?.ms)} ms`,
  ].join("; ");
}

function markdownReport(report) {
  const lines = [
    "# Native sidecar benchmark summary",
    "",
    `Report status: **${report.status.toUpperCase()}**. Expected 10 successful, ACK-paired edits for each benchmark scenario. Failed or incomplete runs are explicitly excluded from successful aggregates.`,
    "",
    `P90 uses the nearest-rank definition (rank = ceil(0.90 × n)). Durations come only from recorded monotonic timestamps or adapter-call ` +
      "`ms` fields; no phase is inferred from total runtime.",
    "",
    "## Inputs",
    "",
    ...(report.inputs.length ? report.inputs.map((input) =>
      `- ${input.input}: scenario \`${input.scenario}\`, status \`${input.status}\`, complete 10-sample run: **${input.completeTenSampleRun ? "yes" : "no"}**${input.error ? ` — ${input.error}` : ""}`) : ["- No inputs."]),
    "",
    "## Observability limits",
    "",
    `- Annotation capture duration: **${report.observability.annotationCaptureDuration}**. It is per recorded \`refreshAnnotationOperations\` invocation, may include no-op calls with operationCount=0, and is not a per-user-edit cost.`,
    `- Sidecar operation encoding duration: **${report.observability.sidecarOperationEncodingDuration}**. \`messages[].encodedBytes\` is payload size, not encoding time.`,
    "- Viewer PDF serialization duration: **NOT OBSERVABLE**. `pdfSerializations` records call timestamps/export permission only.",
    "- Operation replay duration: **NOT OBSERVABLE**.",
    `- Native driver source-PDF hash probes: **${report.observability.driverSourceHashReads}**. ${report.observability.driverSourceHashReadSemantics}`,
    `- Garbage-collection duration (actual GC work): **${report.observability.garbageCollectionDuration}**. GC queue wait is reported separately: **${report.observability.garbageCollectionQueueWaitDuration}**; materialization queue wait is also separate: **${report.observability.garbageCollectionMaterializationQueueWaitDuration}**. Missing queue metrics are NOT OBSERVABLE, not zero. Removed/eligible counters are shown only when emitted by the store trace.`,
    `- ${report.observability.garbageCollectionTimingSemantics}`,
    "- GC duration may include its own checkpoint backup work; it is an independent measured phase and must not be added to primary/backup checkpoint write durations as if the scopes were mutually exclusive.",
    "- Final operation `.json` is published by a measured rename from `.pending`; no direct final-JSON write is claimed. Both pending and final readbacks are reported when present.",
    "",
  ];

  for (const name of ["benchmark-small", "benchmark-large"]) {
    const scenario = report.scenarios[name];
    lines.push(`## ${name}`, "");
    lines.push(`Successful complete runs: **${scenario.successfulCompleteRuns}**; successful ACK-paired samples: **${scenario.successfulSampleCount}**; exactly one complete 10-sample run: **${scenario.exactlyTenSuccessfulSamples ? "yes" : "no"}**.`, "");
    if (!scenario.successfulRuns.length) {
      lines.push("No complete successful 10-edit run was supplied. Partial/failed attempts below are not counted as a completed benchmark.", "");
    }
    for (const run of scenario.successfulRuns) {
      lines.push(`### Successful run: ${run.input}`, "");
      lines.push("| Edit | ACK (ms) | Operations | Message bytes | Pending write (ms / B) | Pending read (ms) | Publish rename (ms) | Final JSON read (ms) | Checkpoint bytes | Heap used (B) |", "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
      for (const sample of run.samples) {
        lines.push(`| ${sample.edit} | ${formatNumber(sample.ackLatencyMs)} | ${formatNumber(sample.operations, 0)} | ${formatNumber(sample.messageEncodedBytes, 0)} | ${formatNumber(sample.batch.pendingWrite?.ms)} / ${formatNumber(sample.batch.pendingWrite?.bytes, 0)} | ${formatNumber(sample.batch.pendingReadback?.ms)} | ${formatNumber(sample.batch.publishRename?.ms)} | ${formatNumber(sample.batch.finalJsonReadback?.ms)} | ${formatNumber(sample.checkpointBytes, 0)} | ${formatNumber(sample.heap?.usedSize, 0)} |`);
      }
      lines.push("", "#### Per-edit metric distributions", "", "| Metric | Mean | Median | P90 | Max | n |", "|---|---:|---:|---:|---:|---:|");
      for (const [key, label] of [
        ["ackLatencyMs", "Save → matching `saved` ACK"],
        ["operationPendingWriteMs", "Operation `.pending` write"],
        ["operationPendingReadbackMs", "Operation `.pending` readback"],
        ["operationPublishRenameMs", "`.pending` → `.json` publish rename"],
        ["operationFinalJsonReadbackMs", "Final operation `.json` readback"],
        ["adapterWriteBytesBeforeAck", "Adapter write bytes before ACK"],
        ["readBinaryBytesBeforeAck", "`readBinary` bytes before ACK"],
        ["messageEncodedBytes", "Bridge message encoded size (not encoding time)"],
        ["checkpointBytes", "Checkpoint primary size at saved stage"],
      ]) {
        const stat = scenario.metrics[key];
        lines.push(`| ${label} | ${formatNumber(stat.mean)} | ${formatNumber(stat.median)} | ${formatNumber(stat.p90)} | ${formatNumber(stat.max)} | ${stat.count} |`);
      }
      lines.push("", "#### Instrumented phase timings (status-separated; not additive across overlapping scopes)", "", "| Phase | Status class (raw statuses) | Duration distribution | GC queue wait distribution | Materialization queue wait distribution | Operation count distribution | No-op calls | Candidate batches | Removed batches | GC eligibility / blocked flags | Events | Missing duration |", "|---|---|---|---|---|---|---:|---|---|---|---:|---:|");
      for (const phase of ["capture", "encode", "gc"]) {
        const phaseSummary = scenario.phaseTimings[phase];
        for (const statusClass of timingStatusClasses) {
          const stat = phaseSummary.byStatus[statusClass];
          const noOpCalls = stat.operationCountObservationCount
            ? `${stat.noOperationEvents}/${stat.operationCountObservationCount} (zero operations)` : "NOT OBSERVABLE";
          const gcEligibility = stat.eligibilityObservationCount
            ? `eligible true ${stat.eligibleTrueEvents}, false ${stat.eligibleFalseEvents}; blocked flag ${stat.blockedEvents}/${stat.blockedObservationCount}`
            : "NOT OBSERVABLE";
          lines.push(`| ${phase} | ${statusClass}${stat.statuses.length ? ` (${stat.statuses.join(", ")})` : ""} | ${formatStats(stat.durationMs)} | ${formatStats(stat.queueWaitMs)} | ${formatStats(stat.materializationQueueWaitMs)} | ${formatStats(stat.operationCount, "ops")} | ${noOpCalls} | ${formatStats(stat.candidateBatchCount, "batches")} | ${formatStats(stat.removedBatchCount, "batches")} | ${gcEligibility} | ${stat.eventCount} | ${stat.eventCount - stat.durationMs.count} |`);
        }
      }
      lines.push("", "#### Whole-run I/O, checkpoint writes, and memory", "");
      lines.push(`Driver source-hash trace coverage: ${scenario.runMetrics.driverSourceHashReadTracePresentRuns}/${scenario.successfulCompleteRuns} complete run(s) contain the optional field; ${scenario.runMetrics.driverSourceHashReadTraceMissingRuns} missing field(s) remain NOT OBSERVABLE, not inferred as zero.`, "");
      lines.push("| Metric | Mean | Median | P90 | Max | n |", "|---|---:|---:|---:|---:|---:|");
      const runMetricLabels = [
        ["adapterWriteBytesTotal", "Adapter write bytes (whole trace / run)"],
        ["readBinaryBytesTotal", "`readBinary` bytes (whole trace / run)"],
        ["sourcePdfReadBinaryBytesTotal", "Source PDF `readBinary` bytes (whole trace / run)"],
        ["driverSourceHashReadCount", "Native driver source-hash probe reads (per run)"],
        ["driverSourceHashReadBytesTotal", "Native driver source-hash probe bytes (per run)"],
        ["driverSourceHashReadByteObservationCount", "Native driver hash-probe records with numeric bytes (per run)"],
        ["sourceWriteAttempts", "Source-PDF write attempts (count/run)"],
        ["pdfSerializationCalls", "Viewer PDF serialization calls (count/run)"],
        ["checkpointPrimaryWriteMs", "Checkpoint primary write duration (per write event)"],
        ["checkpointPrimaryWriteBytes", "Checkpoint primary write bytes (per write event)"],
        ["checkpointBackupWriteMs", "Checkpoint backup write duration (per write event)"],
        ["checkpointBackupWriteBytes", "Checkpoint backup write bytes (per write event)"],
      ];
      for (const [key, label] of runMetricLabels) {
        const stat = scenario.runMetrics[key];
        lines.push(`| ${label} | ${formatNumber(stat.mean)} | ${formatNumber(stat.median)} | ${formatNumber(stat.p90)} | ${formatNumber(stat.max)} | ${stat.count} |`);
      }
      for (const [key, stat] of Object.entries(scenario.memory)) {
        lines.push(`| Heap ${key} (per benchmark edit) | ${formatNumber(stat.mean, 0)} | ${formatNumber(stat.median, 0)} | ${formatNumber(stat.p90, 0)} | ${formatNumber(stat.max, 0)} | ${stat.count} |`);
      }
      lines.push("", "Checkpoint timing covers observed primary/backup writes for this document across the full trace, including asynchronous materialization; it is not attributed to one ACK unless a timestamp falls in that ACK window. GC timing is reported as its own store phase and may overlap those writes.", "");
    }
    if (scenario.incompleteAttempts.length) {
      lines.push("### Failed or incomplete attempts (excluded from successful aggregates)", "");
      for (const attempt of scenario.incompleteAttempts) {
        lines.push(`- ${attempt.input}: status \`${attempt.status}\`, observed ${attempt.observedIterations}/10 iteration records, ${attempt.successfulSavedAcks}/10 successful saved ACKs; ${attempt.completionReasons.join("; ") || "completion criteria not met"}.${attempt.error ? ` Error: ${attempt.error}` : ""}`);
        const timingRows = Object.values(attempt.phaseTimings ?? {}).flat();
        if (timingRows.length) {
          lines.push("", "  Instrumented phase observations (excluded from successful-run aggregates):");
          for (const timing of timingRows) {
            lines.push(`  - ${timing.phase}: status \`${timing.status}\`, duration ${formatNumber(timing.durationMs)} ms, GC queue wait ${formatNumber(timing.queueWaitMs)} ms, materialization queue wait ${formatNumber(timing.materializationQueueWaitMs)} ms, revision ${formatNumber(timing.revision, 0)}, rowCount ${formatNumber(timing.rowCount, 0)}, operations ${formatNumber(timing.operationCount, 0)}, candidates ${formatNumber(timing.candidateBatchCount, 0)} / ${formatNumber(timing.candidateBatchBytes, 0)} B, removed ${formatNumber(timing.removedBatchCount, 0)} / ${formatNumber(timing.removedBatchBytes, 0)} B, eligible ${timing.eligible === null ? "NOT OBSERVABLE" : timing.eligible}, blocked ${timing.blocked === null ? "NOT OBSERVABLE" : timing.blocked}${timing.errorCode ? `, error ${timing.errorCode}` : ""}${timing.docKey ? `, docKey ${timing.docKey}` : ""}.`);
          }
        }
        if (attempt.partialSamples.length) {
          lines.push("", "  | Observed edit | State | ACK latency (ms) | Request ID |", "  |---:|---|---:|---|");
          for (const sample of attempt.partialSamples) {
            lines.push(`  | ${sample.edit} | ${sample.status} | ${formatNumber(sample.ackLatencyMs)} | ${sample.requestId ?? "NOT OBSERVABLE"} |`);
          }
        }
      }
      lines.push("");
    }
  }
  lines.push(`Output JSON: \`${report.outputs.json ?? "stdout only"}\`.`, "");
  return lines.join("\n");
}

function usage() {
  return [
    "Usage:",
    "  node tests/summarize-sidecar-native.mjs <acceptance.json> [<acceptance.json> ...]",
    "      [--output-prefix <path-without-extension>]",
    "  node tests/summarize-sidecar-native.mjs <acceptance.json> [<acceptance.json> ...] --stdout",
    "",
    "Inputs are explicit paths; the script never auto-discovers stale artifacts.",
    "Default output is a timestamped .md/.json pair in tests/artifacts/.",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const inputPaths = args.inputs.map((input) => path.resolve(process.cwd(), input));
  const seen = new Set();
  const inputData = [];
  for (const inputPath of inputPaths) {
    const name = path.basename(inputPath);
    if (!artifactName.test(name)) throw new Error(`Input is not a sidecar-native acceptance artifact: ${name}`);
    if (seen.has(inputPath.toLowerCase())) throw new Error(`Duplicate input path: ${inputPath}`);
    seen.add(inputPath.toLowerCase());
    let parsed;
    try {
      parsed = JSON.parse(await readFile(inputPath, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read/parse ${inputPath}: ${error.message}`);
    }
    inputData.push({ inputPath, parsed });
  }

  const runs = inputData.map(({ inputPath, parsed }) => summarizeRun(inputPath, parsed));
  const scenarios = {
    "benchmark-small": scenarioSummary("benchmark-small", runs),
    "benchmark-large": scenarioSummary("benchmark-large", runs),
  };
  const complete = Object.values(scenarios).every((scenario) => scenario.exactlyTenSuccessfulSamples);
  const generatedAt = new Date().toISOString();
  let outputPrefix = args.outputPrefix
    ? path.resolve(process.cwd(), args.outputPrefix)
    : path.join(root, "tests", "artifacts", `0.7-sidecar-native-summary-${generatedAt.replace(/[-:.TZ]/g, "")}`);
  const outputs = args.stdout ? { markdown: null, json: null } : {
    markdown: `${outputPrefix}.md`,
    json: `${outputPrefix}.json`,
  };
  const report = {
    schemaVersion: 1,
    generatedAt,
    status: complete ? "complete" : "incomplete",
    percentileDefinition: "nearest-rank P90: sorted[ceil(0.90*n)-1]",
    expectedSamplesPerSuccessfulRun: 10,
    inputs: runs.map((run) => ({
      input: run.input,
      scenario: run.scenario,
      status: run.status,
      completeTenSampleRun: run.completeTenSampleRun,
      observedIterations: run.observedIterations,
      successfulSavedAcks: run.successfulSavedAcks,
      completionReasons: run.completionReasons,
      error: run.error,
    })),
    observability: {
      annotationCaptureDuration: phaseObservability(runs, "capture"),
      annotationCaptureTimingSemantics: "Each capture event measures one refreshAnnotationOperations invocation; operationCount=0 events are no-op invocations. Counts are invocation-level and are not a count or cost per user edit.",
      sidecarOperationEncodingDuration: phaseObservability(runs, "encode"),
      viewerPdfSerializationDuration: notObservable,
      viewerPdfSerializationAndEncodingDuration: "PDF serialization duration is NOT OBSERVABLE; sidecar operation encoding is reported separately when trace.viewerTimings includes phase=encode.",
      operationReplayDuration: notObservable,
      driverSourceHashReads: runs.some((run) => run.io.driverSourceHashReadCount !== null)
        ? `OBSERVED (${runs.filter((run) => run.io.driverSourceHashReadCount !== null).length}/${runs.length} input(s) contain report.driverSourceHashReads)`
        : "NOT OBSERVABLE (the input is missing top-level report.driverSourceHashReads)",
      driverSourceHashReadSemantics: "Counts and bytes are Native acceptance-driver source-PDF hash probes, not product readBinary; they are not a complete application I/O accounting. A missing driverSourceHashReads field remains NOT OBSERVABLE, not zero. Driver source hashing and sidecar-tree reads can perturb background GC.",
      garbageCollectionDuration: phaseObservability(runs, "gc"),
      garbageCollectionQueueWaitDuration: phaseObservability(runs, "gc", "queueWaitMs"),
      garbageCollectionMaterializationQueueWaitDuration: phaseObservability(runs, "gc", "materializationQueueWaitMs"),
      garbageCollectionTimingSemantics: "GC durationMs measures actual GC work; queueWaitMs measures time waiting for the GC execution queue; materializationQueueWaitMs measures time waiting for materialization serialization. Both queue waits are reported separately and excluded from durationMs. Materialization queue wait is not operation replay duration, which remains NOT OBSERVABLE. GC work may include checkpoint backup work and can overlap checkpoint write durations.",
      garbageCollectionMayOverlapCheckpointWrites: "GC duration may include backup work; report it as an independent measured scope and do not add it to primary/backup write durations as if mutually exclusive.",
      messageEncodedBytesAreDuration: "NOT OBSERVABLE; encodedBytes is payload size, not time.",
      finalOperationJsonDirectWrite: "NOT OBSERVABLE as a direct write; current store publishes the final .json by measured rename from the .pending path.",
    },
    scenarios,
    outputs,
  };
  const markdown = markdownReport(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.stdout) {
    console.log("===== MARKDOWN =====\n");
    console.log(markdown);
    console.log("\n===== JSON =====\n");
    console.log(json);
    return;
  }

  await mkdir(path.dirname(outputPrefix), { recursive: true });
  const created = [];
  try {
    await writeFile(outputs.markdown, markdown, { flag: "wx" });
    created.push(outputs.markdown);
    await writeFile(outputs.json, json, { flag: "wx" });
    created.push(outputs.json);
  } catch (error) {
    for (const createdPath of created.reverse()) await unlink(createdPath).catch(() => {});
    throw new Error(`Could not create report pair without overwriting existing files: ${error.message}`);
  }
  console.log(JSON.stringify({ status: report.status, outputs }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error.message || error);
  if (process.argv.includes("--help") || process.argv.includes("-h")) process.exitCode = 0;
  else process.exitCode = 2;
}
