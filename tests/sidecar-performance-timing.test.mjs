import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const bridgePath = new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url);
const bridge = await readFile(bridgePath, "utf8");

function functionSource(name) {
  const start = bridge.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const signatureEnd = bridge.indexOf(") {", start);
  assert.notEqual(signatureEnd, -1, `missing body for ${name}`);
  const open = signatureEnd + 2;
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < bridge.length; index += 1) {
    const char = bridge[index];
    const next = bridge[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return bridge.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function makeHarness({ rows = new Map(), logThrows = false, rowError = null, boundedLogs = false } = {}) {
  const hooks = {
    rows,
    logThrows,
    logs: [],
    rowError,
    dirtyIds: [],
    boundedLogs,
  };
  let now = 100;
  const context = vm.createContext({
    hooks,
    performance: {
      timeOrigin: 1_700_000_000_000,
      now() {
        now += 2;
        return now;
      },
    },
  });
  const functions = [
    "encodeBase64",
    "encodeExternalValue",
    "externalOperation",
    "captureDirtySyncState",
    "startSidecarPerformance",
    "recordSidecarPerformance",
    "refreshAnnotationOperations",
    "captureSyncOperations",
  ].map(functionSource).join("\n");
  const boundedLogFunctions = [
    functionSource("runtimeLogRecord").replace("function runtimeLogRecord(", "function bufferedRuntimeLogRecord("),
    functionSource("runtimeLogTake").replace("function runtimeLogTake(", "function bufferedRuntimeLogTake("),
  ].join("\n");
  return vm.runInContext(`(() => {
    const rendererGeneration = "renderer-private";
    const EXTERNAL_ANNOTATION_KINDS = new Set(["Square"]);
    const state = {
      activeDocumentId: "document-private",
      activeOpenRequest: 7,
      revision: 12,
      compactInkEncoding: false,
      syncDeviceId: "device-private",
      syncActorId: "actor-private",
      syncClockTimestamp: 0,
      syncClockLogical: 0,
      syncOperationSequence: 0,
      annotationSnapshot: new Map(),
      annotationOperations: [],
      dirtyAnnotationRevisions: new Map(),
      dirtyPageRevisions: new Map(),
      dirtyNewAnnotationIds: new Set(),
      dirtyDeletedAnnotationIds: new Set(),
      restoredSavedAnnotations: new Map(),
      app: null,
    };
    let runtimeLogRows = [];
    let runtimeLogBytes = 0;
    let runtimeLogLost = 0;
    let runtimeLogSequence = 0;
    let runtimeLogClosed = false;
    const runtimeLogStarted = 0;
    ${boundedLogFunctions}
    function runtimeLogRecord(kind, fields) {
      if (hooks.logThrows) throw new Error("diagnostic sink failed");
      if (hooks.boundedLogs) {
        bufferedRuntimeLogRecord(kind, fields);
        return;
      }
      hooks.logs.push({ kind, fields });
    }
    function getAnnotationStorageRows() {
      if (hooks.rowError) throw hooks.rowError;
      return hooks.rows;
    }
    function markDirtyAnnotation(uuid, pageIndex, action, revision, isNew) {
      state.dirtyAnnotationRevisions.set(uuid, revision);
      if (Number.isSafeInteger(pageIndex)) state.dirtyPageRevisions.set(pageIndex, revision);
      if (isNew) state.dirtyNewAnnotationIds.add(uuid);
      if (action === "delete") state.dirtyDeletedAnnotationIds.add(uuid);
    }
    function makeSyncStamp() {
      return {
        timestamp: 123,
        logical: 0,
        actorId: "actor-private",
        deviceId: "device-private",
        operationId: "operation-private",
      };
    }
    function normalizeSyncKind(kind) { return kind; }
    function canonicalPdfAnnotationRef(reference) { return reference || null; }
    function hasNonDegeneratePdfRect() { return true; }
    ${functions}
    return {
      state,
      hooks,
      refreshAnnotationOperations,
      captureSyncOperations,
      recordRuntimeLog: runtimeLogRecord,
      readRuntimeLog: () => ({ bytes: runtimeLogBytes, lost: runtimeLogLost, rows: [...runtimeLogRows] }),
      takeRuntimeLogs: bufferedRuntimeLogTake,
    };
  })()`, context);
}

function logFields(harness) {
  assert.equal(harness.hooks.logs.length, 1);
  const [entry] = harness.hooks.logs;
  assert.equal(entry.kind, "sidecar-performance");
  return entry.fields;
}

function assertSafeMetadata(fields, phase, {
  operationCount,
  rowCount,
  status = "ok",
  startedAtEpochMs = 1_700_000_000_102,
}) {
  assert.deepEqual(Object.keys(fields).sort(), [
    "documentId", "durationMs", "openRequest", "operationCount", "phase",
    "rendererGeneration", "revision", "rowCount", "startedAtEpochMs", "status",
  ].sort());
  assert.equal(fields.phase, phase);
  assert.equal(fields.documentId, "document-private");
  assert.equal(fields.openRequest, 7);
  assert.equal(fields.rendererGeneration, "renderer-private");
  assert.equal(fields.startedAtEpochMs, startedAtEpochMs);
  assert.equal(fields.durationMs, 2);
  assert.equal(fields.operationCount, operationCount);
  assert.equal(fields.rowCount, rowCount);
  assert.equal(fields.status, status);
  const serialized = JSON.stringify(fields);
  for (const secret of ["private-annotation-uuid", "private annotation text", "operation-private", "device-private"]) {
    assert.equal(serialized.includes(secret), false, `timing telemetry leaked ${secret}`);
  }
}

test("capture and batch encode each emit one metadata-only timing row", () => {
  const rows = new Map([[
    "runtime-editor-0",
    {
      uuid: "private-annotation-uuid",
      signature: "signature-private",
      pageIndex: 0,
      kind: "Square",
      value: { text: "private annotation text", rect: [1, 2, 30, 40] },
    },
  ]]);
  const harness = makeHarness({ rows });

  harness.refreshAnnotationOperations(12);
  assert.equal(harness.state.annotationOperations.length, 1);
  assertSafeMetadata(logFields(harness), "capture", { operationCount: 1, rowCount: 1 });

  harness.hooks.logs.length = 0;
  const operations = harness.captureSyncOperations(12);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].payload.editor.text, "private annotation text");
  assertSafeMetadata(logFields(harness), "encode", {
    operationCount: 1,
    rowCount: 1,
    startedAtEpochMs: 1_700_000_000_106,
  });
});

test("capture and encode failures preserve the original error and report error status", () => {
  const expectedRowError = new Error("capture fixture failure");
  const capture = makeHarness({ rowError: expectedRowError });
  assert.throws(() => capture.refreshAnnotationOperations(12), (error) => error === expectedRowError);
  assertSafeMetadata(logFields(capture), "capture", {
    operationCount: 0,
    rowCount: 0,
    status: "error",
  });

  const encode = makeHarness();
  const cyclicEditor = { text: "private annotation text" };
  cyclicEditor.self = cyclicEditor;
  encode.state.annotationOperations.push({
    revision: 12,
    operation: {
      uuid: "private-annotation-uuid",
      kind: "Square",
      pageIndex: 0,
      timestamp: 123,
      logical: 0,
      deviceId: "device-private",
      operationId: "operation-private",
      payload: { editor: cyclicEditor },
    },
  });
  encode.state.dirtyAnnotationRevisions.set("private-annotation-uuid", 12);
  assert.throws(() => encode.captureSyncOperations(12), /contains a cycle/);
  assertSafeMetadata(logFields(encode), "encode", {
    operationCount: 0,
    rowCount: 1,
    status: "error",
  });
});

test("a throwing timing observer cannot change capture or encode outcomes", () => {
  const rows = new Map([[
    "runtime-editor-0",
    {
      uuid: "private-annotation-uuid",
      signature: "signature-private",
      pageIndex: 0,
      kind: "Square",
      value: { text: "private annotation text", rect: [1, 2, 30, 40] },
    },
  ]]);
  const harness = makeHarness({ rows, logThrows: true });

  assert.doesNotThrow(() => harness.refreshAnnotationOperations(12));
  assert.equal(harness.state.annotationOperations.length, 1);
  const operations = harness.captureSyncOperations(12);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].payload.editor.text, "private annotation text");
});

test("reserved log capacity retains ten encode timings under ordinary trace pressure", () => {
  const rows = new Map([[
    "runtime-editor-0",
    {
      uuid: "private-annotation-uuid",
      signature: "signature-private",
      pageIndex: 0,
      kind: "Square",
      value: { text: "private annotation text", rect: [1, 2, 30, 40] },
    },
  ]]);
  const harness = makeHarness({ rows, boundedLogs: true });
  const ordinaryLimit = 262144 - 32768;

  // Fill the ordinary budget with individual records. The next ordinary row
  // must be dropped rather than consuming the timing reserve.
  const message = "x".repeat(8000);
  while (true) {
    const before = harness.readRuntimeLog();
    harness.recordRuntimeLog("trace.fixture", { message });
    const after = harness.readRuntimeLog();
    if (after.bytes === before.bytes) {
      assert.ok(after.lost > before.lost);
      break;
    }
    assert.ok(after.bytes <= ordinaryLimit);
  }
  assert.ok(harness.readRuntimeLog().bytes <= ordinaryLimit);

  for (let index = 0; index < 10; index += 1) {
    harness.refreshAnnotationOperations(12);
    assert.equal(harness.state.annotationOperations.length, 1);
    const operations = harness.captureSyncOperations(12);
    assert.equal(operations.length, 1);
    assert.equal(operations[0].payload.editor.text, "private annotation text");
  }

  const expectedError = new Error("capture still reports its original failure");
  harness.hooks.rowError = expectedError;
  assert.throws(
    () => harness.refreshAnnotationOperations(12),
    (error) => error === expectedError,
  );

  const buffered = harness.readRuntimeLog();
  assert.ok(buffered.bytes <= 262144);
  const drained = harness.takeRuntimeLogs();
  const records = drained.map((row) => JSON.parse(row));
  const timingRows = records.filter((row) => row.kind === "sidecar-performance");
  assert.equal(timingRows.filter((row) => row.phase === "encode" && row.status === "ok").length, 10);
  assert.equal(timingRows.filter((row) => row.phase === "capture" && row.status === "ok").length, 10);
  assert.equal(timingRows.filter((row) => row.phase === "capture" && row.status === "error").length, 1);
  assert.ok(records.some((row) => row.kind === "log-loss" && row.dropped > 0));
  assert.ok(drained.reduce((sum, row) => sum + row.length, 0) <= 262144);
  for (const record of timingRows) {
    assert.equal(JSON.stringify(record).includes("private annotation text"), false);
    assert.equal(JSON.stringify(record).includes("private-annotation-uuid"), false);
  }
});
