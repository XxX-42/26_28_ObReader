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
  const open = signatureEnd + 2;
  assert.notEqual(open, -1, `missing body for ${name}`);
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

function region(start, end) {
  const from = bridge.indexOf(start);
  assert.notEqual(from, -1, `missing region start: ${start}`);
  const to = bridge.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing region end: ${end}`);
  return bridge.slice(from, to);
}

function evaluateHelpers(names, body) {
  const helpers = names.map(functionSource).join("\n");
  return vm.runInThisContext(`(() => { ${body}\n${helpers}\nreturn { ${names.join(", ")} }; })()`);
}

test("daily save, recovery, checkpoint, sync and close never serialize a PDF", () => {
  assert.equal([...bridge.matchAll(/\.saveDocument\s*\(/g)].length, 1);
  assert.match(functionSource("handleExportCopy"), /pdfDocument\.saveDocument\(\)/);

  for (const [name, next] of [
    ["serializeSyncCheckpoint", "function handleSyncCheckpoint"],
    ["saveOneRevision", "async function runSaveSequence"],
    ["runRecoverySequence", "async function requestRecovery"],
    ["handleFlush", "function handleExternalAnnotationsUpdate"],
    ["applySyncSnapshot", "function waitForInputBoundary"],
  ]) {
    assert.doesNotMatch(region(`function ${name}(`, next), /saveDocument\s*\(/);
    assert.doesNotMatch(region(`function ${name}(`, next), /modifyBinary|appendBinary/);
  }

  const saveWait = functionSource("waitForHostSave");
  const recoveryWait = functionSource("waitForHostRecovery");
  for (const source of [saveWait, recoveryWait]) {
    assert.match(source, /postToHost\(\s*"(?:save|recover)"/);
    assert.match(source, /operations,/);
    assert.doesNotMatch(source, /\bdata\s*:/);
  }
  assert.match(recoveryWait, /source,/);
  assert.doesNotMatch(functionSource("serializeSyncCheckpoint"), /saveDocument\s*\(|getData\s*\(/);
});

test("external annotation operation batches preserve identity, tombstones and binary editor state", () => {
  const { externalOperation, encodeExternalValue, decodeExternalValue } = evaluateHelpers(
    ["encodeExternalValue", "decodeExternalValue", "encodeBase64", "decodeBase64", "externalOperation"],
    `
      const EXTERNAL_ANNOTATION_KINDS = new Set(["Underline", "Square", "Highlight", "Ink", "InkHighlight", "FreeText"]);
      const state = { syncDeviceId: "device-a", syncActorId: "actor-a" };
      function normalizeSyncKind(value) { return value; }
      function canonicalPdfAnnotationRef(value) {
        if (typeof value !== "string") return null;
        const match = /^(\\d+)R(\\d+)?$/.exec(value);
        return match ? match[1] + "R" + (match[2] === "0" ? "" : match[2] || "") : null;
      }
    `,
  );

  const binaryPayload = {
    annotationType: "Ink",
    pageIndex: 16,
    outlines: new Float32Array([0.1, 0.2, 0.3, 0.4]),
    imageData: new Uint8Array([0, 7, 255]),
    metadata: new Map([["z", 2], ["a", 1]]),
  };
  const encoded = encodeExternalValue(binaryPayload);
  const decoded = decodeExternalValue(encoded);
  assert.ok(Array.from(decoded.outlines).every((value, index) =>
    Math.abs(value - [0.1, 0.2, 0.3, 0.4][index]) < 1e-6
  ));
  assert.deepEqual(Array.from(decoded.imageData), [0, 7, 255]);
  assert.deepEqual([...decoded.metadata.entries()], [["a", 1], ["z", 2]]);

  const inkValues = Float32Array.from({ length: 4150 }, (_, index) =>
    index % 148 === 0 ? Number.NaN : Math.fround((index % 997) * 0.1234567));
  const legacyInkJson = JSON.stringify(encodeExternalValue({ lines: inkValues, points: inkValues }));
  const compactInk = encodeExternalValue({ lines: inkValues, points: inkValues }, new Set(), true);
  const compactInkJson = JSON.stringify(compactInk);
  assert.ok(compactInkJson.length <= legacyInkJson.length * 0.4,
    `compact Float32 representation should save at least 60% (${legacyInkJson.length} -> ${compactInkJson.length})`);
  assert.equal(compactInk.lines.$type, "Float32ArrayLE");
  assert.equal(compactInk.points.$type, "Float32ArrayLE", "visual lines and PDF points are both preserved");
  assert.doesNotMatch(compactInkJson, /NonFiniteNumber/);
  const compactRoundTrip = decodeExternalValue(compactInk);
  assert.equal(compactRoundTrip.lines.length, inkValues.length);
  assert.equal(compactRoundTrip.points.length, inkValues.length);
  for (let index = 0; index < inkValues.length; index += 1) {
    if (Number.isNaN(inkValues[index])) {
      assert.equal(Number.isNaN(compactRoundTrip.lines[index]), true, `NaN marker at ${index} must round-trip`);
    } else {
      assert.equal(compactRoundTrip.lines[index], inkValues[index], `Float32 precision at ${index} must be exact`);
    }
  }

  const operation = externalOperation({
    uuid: "annotation-1",
    kind: "Ink",
    pageIndex: 16,
    ref: "42R0",
    action: "upsert",
    timestamp: 1234,
    logical: 8,
    deviceId: "device-a",
    operationId: "actor-a:1234:8:1",
    payload: { editor: binaryPayload },
  });
  assert.deepEqual(Object.keys(operation).sort(), [
    "clock", "deleted", "embeddedRef", "kind", "pageIndex", "payload", "uuid",
  ]);
  assert.deepEqual(operation.clock, {
    timestamp: 1234,
    logical: 8,
    deviceId: "device-a",
    opId: "actor-a:1234:8:1",
  });
  assert.equal(operation.embeddedRef, "42R");
  assert.deepEqual(Array.from(decodeExternalValue(operation.payload.editor).imageData), [0, 7, 255]);

  const tombstone = externalOperation({
    uuid: "annotation-1",
    kind: "Ink",
    pageIndex: 16,
    action: "delete",
    timestamp: 1235,
    logical: 0,
    deviceId: "device-a",
    operationId: "actor-a:1235:0:2",
  });
  assert.equal(tombstone.deleted, true);
  assert.equal(Object.hasOwn(tombstone, "payload"), false);
});

test("free-highlight payloads are distinguished from text highlights for lossless hydration", () => {
  const { externalKindForEditor } = evaluateHelpers(
    ["externalKindForEditor"],
    `function normalizeSyncKind(value) {
      if (value === 9) return "Highlight";
      return value;
    }`,
  );
  assert.equal(externalKindForEditor({ annotationType: 9, quadPoints: [1, 2, 3, 4], outlines: { points: [] } }), "Highlight");
  assert.equal(externalKindForEditor({ annotationType: 9, quadPoints: null, outlines: { points: [0, 1, 2] } }), "InkHighlight");
  assert.equal(externalKindForEditor({ annotationType: 9, inkLists: [[0, 1, 2]] }), "InkHighlight");
});

test("schema 2 snapshots synthesize deletion operations from a compact tombstone ledger", () => {
  const { validateExternalAnnotations, decodeExternalValue, decodeBase64 } = evaluateHelpers(
    ["validateExternalAnnotations", "decodeExternalValue", "decodeBase64"],
    `
      const EXTERNAL_ANNOTATION_KINDS = new Set(["Underline", "Square", "Highlight", "Ink", "InkHighlight", "FreeText"]);
      function normalizeSyncKind(value) { return value; }
      function canonicalPdfAnnotationRef(value) {
        if (typeof value !== "string") return null;
        const match = /^(\\d+)\\s*(?:R)?(\\d+)?$/.exec(value);
        return match ? match[1] + "R" + (match[2] === "0" ? "" : match[2] || "") : null;
      }
      function normalizeSyncValue(value) { return value; }
    `,
  );
  const tombstone = {
    uuid: "deleted-annotation",
    kind: "Ink",
    pageIndex: 3,
    embeddedRef: null,
    clock: { timestamp: 123, logical: 1, deviceId: "device-a", opId: "delete-1" },
  };
  const normalized = validateExternalAnnotations({
    schemaVersion: 2,
    annotations: [],
    tombstones: [tombstone],
    compactInkEncoding: true,
  });
  assert.equal(normalized.annotations.length, 1);
  assert.equal(normalized.annotations[0].deleted, true);
  assert.equal(normalized.annotations[0].editor, null);
  assert.equal(normalized.compactInkEncoding, true);
  assert.throws(() => validateExternalAnnotations({
    schemaVersion: 2,
    annotations: [],
    tombstones: [{ ...tombstone, deleted: true }],
  }), /must not contain deleted operation rows/);
});

test("hydration waits for host source confirmation and touches only exact embedded references", () => {
  assert.match(functionSource("handleExternalAnnotationsUpdate"), /\["MATCH", "BASELINE_ESTABLISHED"\]/);
  assert.match(functionSource("applyExternalAnnotationsSnapshot"), /externalSourceIdentityMatchesViewer\(normalized\.source\)/);
  assert.match(functionSource("externalSourceIdentityMatchesViewer"), /identityStatus !== "KNOWN"/);
  assert.match(functionSource("externalSourceIdentityMatchesViewer"), /orderedPageIdentities/);
  assert.match(functionSource("hydrateExternalAnnotation"), /layer\.deserialize\(payload\)/);
  assert.match(functionSource("hydrateExternalAnnotation"), /layer\.add\(editor\)/);
  assert.match(functionSource("hydrateExternalAnnotation"), /annotationEditorLayer\?\.show\?\.\(\)/);
  assert.match(functionSource("suppressEmbeddedAnnotation"), /querySelectorAll\("\[data-annotation-id\]"\)/);
  assert.match(functionSource("findEmbeddedEditor"), /editor\?\.annotationElementId/);
  assert.match(functionSource("reportAnnotationSourceIdentity"), /pdfDocument\.getPage\(pageIndex \+ 1\)/);
  assert.match(functionSource("reportAnnotationSourceIdentity"), /identityStatus/);
  assert.doesNotMatch(functionSource("reportAnnotationSourceIdentity"), /getPageFingerprint|\.getData\(|\.getOperatorList\(/);
  const open = functionSource("openDocument");
  assert.match(open, /const provisionalExternal = validateExternalAnnotations\(message\.externalAnnotations\)/);
  assert.doesNotMatch(open, /applyExternalAnnotationsSnapshot\(message\.externalAnnotations/);
  assert.match(open, /state\.readOnly\s*=\s*true/);
  const pendingUpdate = functionSource("schedulePendingExternalAnnotationUpdate");
  assert.match(pendingUpdate, /pending\.identityConfirmed\s*===\s*true\s*\|\|\s*state\.externalSourceConfirmed/);
  assert.match(pendingUpdate, /setReadOnlyState\(state\.readOnly\)/);
  assert.match(functionSource("handleExternalAnnotationsUpdate"), /message\.identityConfirmed\s*!==\s*true/);
});

test("legacy UUIDs bind by exact annotation object reference before dirty diffs", () => {
  const scope = vm.runInThisContext(`(() => {
    const state = { app: { pdfDocument: { numPages: 2 } }, annotationUuidByPdfRef: new Map() };
    function canonicalPdfAnnotationRef(value) {
      if (typeof value !== "string") return null;
      const match = /^(\\d+)\\s+(\\d+)\\s+R$/.exec(value) || /^(\\d+)R(\\d*)$/.exec(value);
      if (!match) return null;
      const generation = match[2] || match[3] || "0";
      return match[1] + "R" + (generation === "0" ? "" : generation);
    }
    function pdfAnnotationRefKey(value) {
      const match = /^(\\d+)R(\\d*)$/.exec(value || "");
      return match ? match[1] + ":" + (match[2] || "0") : null;
    }
    ${functionSource("applyLegacyAnnotationIdentities")}
    return { state, applyLegacyAnnotationIdentities };
  })()`);
  scope.applyLegacyAnnotationIdentities([
    { uuid: "legacy-uuid", ref: "42 0 R", pageIndex: 1 },
    { uuid: "out-of-range", ref: "43 0 R", pageIndex: 2 },
  ]);
  assert.equal(scope.state.annotationUuidByPdfRef.get("42:0"), "legacy-uuid");
  assert.equal(scope.state.annotationUuidByPdfRef.size, 1);
  assert.match(functionSource("validateExternalAnnotations"), /legacyIdentityRefs/);
  assert.match(functionSource("openDocument"), /applyLegacyAnnotationIdentities\(provisionalExternal\.legacyIdentities\)/);
});

test("durable acknowledgements are scoped to the exact document, open request and revision", () => {
  const handler = region('if (message.type === "recovered")', 'function installAppHooks');
  assert.match(handler, /message\.requestId !== pending\.requestId/);
  assert.match(handler, /message\.documentId !== pending\.documentId/);
  assert.match(handler, /message\.openRequest !== pending\.openRequest/);
  assert.match(handler, /message\.revision !== pending\.revision/);
  assert.match(handler, /message\.ok !== true/);
  assert.match(functionSource("recoverySourceIdentity"), /orderedPageIdentities/);
  assert.match(functionSource("recoverySourceIdentity"), /sourceHash/);
});
