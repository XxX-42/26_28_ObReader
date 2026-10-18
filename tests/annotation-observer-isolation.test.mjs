import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const bridgePath = new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url);
const bridge = await readFile(bridgePath, "utf8");

function functionSource(name) {
  let start = bridge.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  if (bridge.slice(start - 6, start) === "async ") start -= 6;
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

function evaluateHelpers(names, body, exposed = []) {
  const helpers = names.map(functionSource).join("\n");
  return vm.runInThisContext(`(() => { ${body}\n${helpers}\nreturn { ${[...names, ...exposed].join(", ")} }; })()`);
}

test("mutation capture failures stay dirty and never advance a confirmed revision", () => {
  const { noteMutation, state } = evaluateHelpers(
    ["recordAnnotationTrackingFailure", "runAnnotationObserver", "noteMutation"],
    `
      const state = {
        activeDocumentId: "doc-1", disposed: false, hydratingExternalAnnotations: false,
        revision: 8, confirmedRevision: 7, dirty: false, autoSavePending: false,
        lastRecoveredDocumentId: "doc-1", lastRecoveredRevision: 7,
        lastCloseWritebackAck: { durable: true }, annotationTrackingFailure: null,
        app: { _updateOverwriteOriginalState() {}, setTitle() {} },
      };
      function refreshAnnotationOperations() {
        const error = new Error("unbound deletion placeholder");
        error.code = "annotation-deletion-identity-unresolved";
        throw error;
      }
      function runtimeLogRecord() {}
      function runtimeLogError(error) { return error; }
      function syncBridgeControls() {}
      function scheduleAutoSave() {}
    `,
    ["state"],
  );

  assert.doesNotThrow(() => noteMutation());
  assert.equal(state.revision, 9);
  assert.equal(state.dirty, true);
  assert.equal(state.autoSavePending, true);
  assert.equal(state.confirmedRevision, 7);
  assert.equal(state.lastCloseWritebackAck, null);
  assert.equal(state.annotationTrackingFailure?.phase, "mutation.capture");
  assert.equal(state.annotationTrackingFailure?.code, "annotation-deletion-identity-unresolved");
});

test("storage and editor observers isolate post-call failures but preserve model exceptions", () => {
  const { observeAnnotationStorage, observeEditorManager, state, storage, manager, calls } = evaluateHelpers(
    ["recordAnnotationTrackingFailure", "runAnnotationObserver", "wrapMethod", "cleanupStorageObserver", "observeAnnotationStorage", "observeEditorManager"],
    `
      const calls = [];
      const state = {
        activeDocumentId: "doc-1", disposed: false, hydratingExternalAnnotations: false,
        revision: 0, dirty: false, autoSavePending: false,
        annotationTrackingFailure: null, deferredAccessibilityMoves: new Map(),
        accessibilityManagers: new WeakSet(), accessibilityEditorLayers: new WeakSet(),
        app: null,
      };
      function noteMutation() { throw new Error("injected observer failure"); }
      function rememberAnnotationEditorIdentity() {}
      function scheduleFreeTextGeometryRefresh() {}
      function captureSavedEditorHistory() { return []; }
      function snapshotSavedFreeTextEditors() { return new Map(); }
      function changedSavedFreeTextEditors() { return []; }
      function getAnnotationStorageRows() { return new Map(); }
      function hasSavedEditorHistoryTransition() { return false; }
      function annotationRowsChanged() { return false; }
      function reconcileSavedEditorHistory() {}
      function queueFreeTextAppearanceRepair() {}
      function discardDeferredAccessibilityMove() {}
      function runtimeLogRecord() {}
      function runtimeLogError(error) { return error; }
      const entries = new Map([["present", { value: 1 }]]);
      const storage = {
        onModified() { calls.push("prior-onModified"); },
        entries,
        has(key) {
          if (this.failHasOnce) {
            this.failHasOnce = false;
            throw new Error("storage has observer failure");
          }
          return this.entries.has(key);
        },
        remove(key) {
          calls.push("remove");
          if (this.failRemove) throw new Error("storage model failure");
          return this.entries.delete(key);
        },
        updateEditor() {
          calls.push("updateEditor");
          if (this.failUpdate) throw new Error("storage model failure");
          return true;
        },
      };
      const manager = {
        addEditor() {},
        addCommands() {
          calls.push("addCommands");
          if (this.failCommands) throw new Error("manager model failure");
          return "command-result";
        },
        undo() {}, redo() {},
        removeEditor() {
          calls.push("removeEditor");
          if (this.failRemoveEditor) throw new Error("manager model failure");
          return "remove-result";
        },
        addDeletedAnnotationElement() {}, removeDeletedAnnotationElement() {},
      };
      const app = { pdfDocument: { annotationStorage: storage },
        pdfViewer: { _layerProperties: { annotationEditorUIManager: manager } } };
      state.app = app;
    `,
    ["state", "storage", "manager", "calls"],
  );

  observeAnnotationStorage(storage);
  observeEditorManager({ ...state.app, pdfDocument: { annotationStorage: storage }, pdfViewer: state.app.pdfViewer });

  assert.equal(storage.remove("present"), true);
  assert.equal(storage.updateEditor("id", {}), true);
  storage.onModified();
  assert.equal(manager.addCommands({ cmd() {} }), "command-result");
  assert.equal(manager.removeEditor({ id: "changed", hasBeenModified: true }), "remove-result");

  storage.entries.set("preflight-remove", { value: 2 });
  storage.failHasOnce = true;
  assert.equal(storage.remove("preflight-remove"), true,
    "a failing has preflight must not prevent the storage model removal");
  assert.equal(storage.entries.has("preflight-remove"), false);

  storage.failHasOnce = true;
  assert.equal(manager.removeEditor({ id: "preflight-editor", hasBeenModified: false }), "remove-result",
    "a failing has preflight must not prevent the editor manager removal");
  assert.equal(calls.filter((call) => call === "removeEditor").length, 2);
  assert.ok(state.annotationTrackingFailure, "observer failures are recorded");
  assert.ok(calls.includes("prior-onModified"));

  storage.failRemove = true;
  storage.failUpdate = true;
  manager.failCommands = true;
  manager.failRemoveEditor = true;
  assert.throws(() => storage.remove("other"), /storage model failure/);
  assert.throws(() => storage.updateEditor("other", {}), /storage model failure/);
  assert.throws(() => manager.addCommands({ cmd() {} }), /manager model failure/);
  assert.throws(() => manager.removeEditor({ id: "changed", hasBeenModified: true }), /manager model failure/);
});

test("undo and redo still execute when their observer pre-snapshot fails", () => {
  const { observeEditorManager, manager, state, calls } = evaluateHelpers(
    ["recordAnnotationTrackingFailure", "runAnnotationObserver", "wrapMethod", "cleanupStorageObserver", "observeEditorManager"],
    `
      const calls = [];
      const state = { activeDocumentId: "doc-1", disposed: false, revision: 2,
        dirty: false, autoSavePending: false, annotationTrackingFailure: null,
        deferredAccessibilityMoves: new Map(), accessibilityManagers: new WeakSet(),
        accessibilityEditorLayers: new WeakSet(), app: null };
      function getAnnotationStorageRows() { throw new Error("snapshot injection"); }
      function noteMutation() { calls.push("mutation-fallback"); }
      function rememberAnnotationEditorIdentity() {}
      function scheduleFreeTextGeometryRefresh() {}
      function captureSavedEditorHistory() { return []; }
      function snapshotSavedFreeTextEditors() { return new Map(); }
      function changedSavedFreeTextEditors() { return []; }
      function hasSavedEditorHistoryTransition() { return false; }
      function annotationRowsChanged() { return false; }
      function reconcileSavedEditorHistory() {}
      function queueFreeTextAppearanceRepair() {}
      function discardDeferredAccessibilityMove() {}
      function runtimeLogRecord() {}
      function runtimeLogError(error) { return error; }
      const manager = {
        addEditor() {}, addCommands() {}, removeEditor() {},
        addDeletedAnnotationElement() {}, removeDeletedAnnotationElement() {},
        undo() { calls.push("undo-model"); return "undone"; },
        redo() { calls.push("redo-model"); return "redone"; },
      };
      const app = { pdfDocument: { annotationStorage: { has() { return false; } } },
        pdfViewer: { _layerProperties: { annotationEditorUIManager: manager } } };
      state.app = app;
    `,
    ["manager", "state", "calls"],
  );
  observeEditorManager(state.app);

  assert.equal(manager.undo(), "undone");
  assert.equal(manager.redo(), "redone");
  assert.ok(calls.includes("undo-model"));
  assert.ok(calls.includes("redo-model"));
  assert.equal(calls.filter((call) => call === "mutation-fallback").length, 2);
  assert.equal(state.dirty, true);
  assert.equal(state.annotationTrackingFailure?.phase, "history.before");
});

test("a registered live editor resolves its later tombstone without inventing a deletion UUID", () => {
  const { observeEditorManager, rememberAnnotationEditorIdentity, getAnnotationStorageRows, manager, state, storageMap, generatedUuids } = evaluateHelpers(
    ["canonicalPdfAnnotationRef", "pdfAnnotationRefKey", "getPdfAnnotationRef", "normalizeSyncValue", "normalizeSyncKind", "externalKindForEditor", "hasNonDegeneratePdfRect", "rememberAnnotationEditorIdentity", "recordAnnotationTrackingFailure", "runAnnotationObserver", "wrapMethod", "cleanupStorageObserver", "observeEditorManager", "getAnnotationStorageRows"],
    `
      const EXTERNAL_ANNOTATION_KINDS = new Set(["Underline", "Square", "Highlight", "Ink", "InkHighlight", "FreeText"]);
      const generatedUuids = [];
      const state = {
        annotationUuidByRuntimeId: new Map(), annotationUuidByPdfRef: new Map(),
        annotationRefByRuntimeId: new Map(), annotationRuntimeBindings: new Map(),
        annotationSnapshot: new Map(), externalAnnotationRows: new Map(),
        embeddedDeletionTargets: new Map(), syncState: null,
        deferredAccessibilityMoves: new Map(), accessibilityManagers: new WeakSet(),
        accessibilityEditorLayers: new WeakSet(), dirty: false, autoSavePending: false,
      };
      function makeSyncUuid() { generatedUuids.push("editor-identity"); return "uuid-live-1"; }
      function noteMutation() {}
      function scheduleFreeTextGeometryRefresh() {}
      function captureSavedEditorHistory() { return []; }
      function snapshotSavedFreeTextEditors() { return new Map(); }
      function changedSavedFreeTextEditors() { return []; }
      function getSavedRows() { return new Map(); }
      function hasSavedEditorHistoryTransition() { return false; }
      function annotationRowsChanged() { return false; }
      function reconcileSavedEditorHistory() {}
      function queueFreeTextAppearanceRepair() {}
      function discardDeferredAccessibilityMove() {}
      function runtimeLogRecord() {}
      function runtimeLogError(error) { return error; }
      function normalizeSyncValue(value) { return structuredClone(value); }
      function canonicalPdfAnnotationRef(value) {
        return typeof value === "string" && /^\\d+R\\d*$/.test(value) ? value.replace(/R0$/, "R") : null;
      }
      function pdfAnnotationRefKey(value) { return value ? value.replace("R", ":") : null; }
      function getPdfAnnotationRef(value) { return canonicalPdfAnnotationRef(value?.annotationElementId); }
      function hasNonDegeneratePdfRect() { return false; }
      const editors = new Map();
      const storageMap = new Map();
      const storage = { serializable: { map: storageMap }, getRawValue() { return null; } };
      const manager = {
        addEditor(editor) { editors.set(editor.id, editor); return editor; },
        getEditor(id) { return editors.get(id) || null; },
        getEditors(pageIndex) { return [...editors.values()].filter((editor) => editor.pageIndex === pageIndex); },
        addCommands() {}, undo() {}, redo() {}, removeEditor() {},
        addDeletedAnnotationElement() {}, removeDeletedAnnotationElement() {},
      };
      const app = { pdfDocument: { numPages: 4, annotationStorage: storage },
        pdfViewer: { _layerProperties: { annotationEditorUIManager: manager } } };
    `,
    ["state", "manager", "app", "storageMap", "generatedUuids"],
  );
  observeEditorManager({ pdfDocument: { annotationStorage: { has() { return false; } } }, pdfViewer: { _layerProperties: { annotationEditorUIManager: manager } } });
  manager.addEditor({ id: "runtime-ink-7", editorType: "Ink", pageIndex: 2 });
  manager.getEditor = () => null;
  state.annotationSnapshot.set("runtime-ink-7", {
    uuid: "uuid-live-1", kind: "Ink", pageIndex: 2,
  });
  state.annotationSnapshot.clear();
  storageMap.set("runtime-ink-7", { deleted: true });

  const row = getAnnotationStorageRows({ pdfDocument: { numPages: 4, annotationStorage: { serializable: { map: storageMap }, getRawValue() { return null; } } }, pdfViewer: { _layerProperties: { annotationEditorUIManager: manager } } }).get("runtime-ink-7");
  assert.equal(row.uuid, "uuid-live-1");
  assert.equal(row.kind, "Ink");
  assert.equal(row.pageIndex, 2);
  assert.equal(row.deleted, true);
  assert.equal(state.annotationUuidByRuntimeId.get("runtime-ink-7"), "uuid-live-1");
  assert.deepEqual(state.annotationRuntimeBindings.get("runtime-ink-7"), {
    uuid: "uuid-live-1", kind: "Ink", pageIndex: 2,
  });
  assert.equal(generatedUuids.length, 1, "only live editor registration may allocate an identity");

  state.hydratingExternalAnnotations = true;
  manager.addEditor({ id: "hydrated-runtime-9", editorType: "Ink", pageIndex: 1 });
  state.hydratingExternalAnnotations = false;
  assert.equal(state.annotationUuidByRuntimeId.has("hydrated-runtime-9"), false,
    "hydration registration must not allocate a second transient identity");
  assert.equal(state.annotationRuntimeBindings.has("hydrated-runtime-9"), false);
  assert.equal(generatedUuids.length, 1);

  const nativeEditor = {
    id: "native-runtime-10", editorType: "Ink", pageIndex: 1,
    annotationElementId: "44R",
    serialize() { return { type: "ink", pageIndex: 1, annotationElementId: "44R" }; },
  };
  manager.addEditor(nativeEditor);
  assert.equal(state.annotationUuidByRuntimeId.has(nativeEditor.id), false,
    "a native editor with an unresolved PDF ref must wait for verified identity");
  assert.equal(state.annotationRuntimeBindings.has(nativeEditor.id), false);
  assert.equal(generatedUuids.length, 1, "an unresolved native ref must not get a generated UUID");
  state.annotationUuidByPdfRef.set("44:0", "canonical-ref-uuid");
  const nativeRow = getAnnotationStorageRows({
    pdfDocument: { numPages: 4, annotationStorage: { serializable: { map: storageMap }, getRawValue() { return null; } } },
    pdfViewer: { _layerProperties: { annotationEditorUIManager: manager } },
  }, { includeLiveEditors: true }).get(nativeEditor.id);
  assert.equal(nativeRow.uuid, "canonical-ref-uuid");
  assert.equal(state.annotationUuidByRuntimeId.get(nativeEditor.id), "canonical-ref-uuid");
  assert.deepEqual(state.annotationRuntimeBindings.get(nativeEditor.id), {
    uuid: "canonical-ref-uuid", kind: "Ink", pageIndex: 1,
  });
  assert.equal(generatedUuids.length, 1, "late verified mapping must bind canonically without allocating");

  storageMap.clear();
  storageMap.set("unbound-placeholder", { deleted: true });
  assert.throws(() => getAnnotationStorageRows({
    pdfDocument: { numPages: 4, annotationStorage: { serializable: { map: storageMap }, getRawValue() { return null; } } },
    pdfViewer: { _layerProperties: { annotationEditorUIManager: manager } },
  }), (error) => error.code === "annotation-deletion-identity-unresolved");
  assert.equal(generatedUuids.length, 1, "an unresolved tombstone must never receive a UUID");
});

test("live-editor serialization errors reject explicit save before any host ACK", async () => {
  const { saveOneRevision, captureOperationSnapshot, assertCompleteOperationSnapshot, state, hostSaves, errors } = evaluateHelpers(
    ["normalizeSyncValue", "canonicalPdfAnnotationRef", "pdfAnnotationRefKey", "getPdfAnnotationRef", "normalizeSyncKind", "externalKindForEditor", "hasNonDegeneratePdfRect", "getAnnotationStorageRows", "refreshAnnotationOperations", "captureOperationSnapshot", "assertCompleteOperationSnapshot", "saveOneRevision"],
    `
      const EXTERNAL_ANNOTATION_KINDS = new Set(["Underline", "Square", "Highlight", "Ink", "InkHighlight", "FreeText"]);
      const hostSaves = [];
      const errors = [];
      const editor = { id: "broken-live-editor", editorType: "Ink", pageIndex: 0,
        serialize() { throw new Error("live editor serialization failure"); } };
      const manager = { getEditors() { return [editor]; }, getEditor() { return editor; } };
      const pdfDocument = { numPages: 1, annotationStorage: { serializable: { map: new Map() }, resetModified() {} } };
      const app = { pdfDocument, pdfViewer: { _layerProperties: { annotationEditorUIManager: manager } },
        _updateOverwriteOriginalState() {}, setTitle() {} };
      const state = {
        app, activeDocumentId: "doc-1", activeOpenRequest: 3, disposed: false,
        revision: 11, confirmedRevision: 10, dirty: true, dirtyPageRevisions: new Map(),
        annotationSnapshot: new Map(), annotationOperations: [], restoredSavedAnnotations: new Map(),
        dirtyAnnotationRevisions: new Map(), dirtyNewAnnotationIds: new Set(),
        dirtyDeletedAnnotationIds: new Set(), pendingBulkDeletedUuids: new Set(),
        annotationUuidByRuntimeId: new Map(), annotationUuidByPdfRef: new Map(),
        annotationRefByRuntimeId: new Map(), annotationRuntimeBindings: new Map(),
        externalAnnotationRows: new Map(), embeddedDeletionTargets: new Map(), syncState: null,
        externalSourceMismatch: false, externalSourceConfirmed: true, readOnly: false,
        autoSavePaused: false, autoSavePending: false, annotationTrackingFailure: null,
      };
      function normalizeSyncValue(value) { return structuredClone(value); }
      function canonicalPdfAnnotationRef(value) { return typeof value === "string" && /^\\d+R\\d*$/.test(value) ? value : null; }
      function pdfAnnotationRefKey(value) { return value ? value.replace("R", ":") : null; }
      function getPdfAnnotationRef(value) { return canonicalPdfAnnotationRef(value?.annotationElementId); }
      function hasNonDegeneratePdfRect() { return false; }
      function makeSyncUuid() { throw new Error("unexpected UUID allocation"); }
      function runtimeLogRecord() {}
      function runtimeLogError(error) { return error; }
      function captureDirtySyncState() { return { dirtyAnnotationIds: [], dirtyPageIndices: [], newAnnotationIds: [], deletedAnnotationIds: [] }; }
      function captureSyncOperations() { return []; }
      function makeSyncStamp() { return {}; }
      function markDirtyAnnotation() {}
      function isDirty() { return true; }
      function isEditBoundaryBusy() { return false; }
      function snapshotChanges() { return { hadAnnotationChanges: true, hadStructuralChanges: false }; }
      function restoreChanges() {}
      function clearAutoSaveTimer() {}
      function sendError(message, fields) { errors.push({ message, fields }); }
      function showStatus() {}
      function waitForHostSave() { hostSaves.push("sent"); return Promise.resolve(); }
      function finishSavePhase() {}
      function releaseHostHeavyLease() {}
      function sessionCurrent() { return true; }
    `,
    ["state", "hostSaves", "errors"],
  );
  const snapshot = captureOperationSnapshot(state.revision, "test-save");
  assert.equal(snapshot.capture.liveEditorSerializationErrorCount, 1);
  assert.throws(() => assertCompleteOperationSnapshot(snapshot, "current PDF"), /complete lossless/);

  assert.equal(await saveOneRevision("manual"), false);
  assert.deepEqual(hostSaves, [], "save cannot reach the host with a partial live-editor snapshot");
  assert.equal(state.confirmedRevision, 10);
  assert.equal(state.dirty, true);
  assert.match(errors[0]?.message, /complete lossless/);

  state.app.pdfDocument.annotationStorage.serializable.map.set(
    "unbound-placeholder",
    { deleted: true },
  );
  assert.throws(
    () => captureOperationSnapshot(state.revision, "test-tombstone"),
    (error) => error.code === "annotation-deletion-identity-unresolved",
  );
  assert.equal(await saveOneRevision("manual"), false);
  assert.deepEqual(hostSaves, [], "an unresolved tombstone cannot reach the host ACK path");
  assert.equal(state.confirmedRevision, 10);
  assert.match(errors.at(-1)?.message, /Deletion placeholder/);
});

test("save, autosave, and export report preparation failures without success ACKs", async () => {
  const { requestSave, runAutoSaveAfterIdle, handleExportCopy, state, messages, errors } = evaluateHelpers(
    ["recordAnnotationTrackingFailure", "failAnnotationPreparation", "prepareContentForSave", "requestSave", "runAutoSaveAfterIdle", "handleExportCopy"],
    `
      const messages = [];
      const errors = [];
      const pdfDocument = { numPages: 1, annotationStorage: { serializable: { map: new Map() } } };
      const currentLayer = { endDrawingSession() { throw new Error("injected ink commit failure"); } };
      const manager = { currentLayer };
      const app = { pdfDocument, pdfViewer: { _layerProperties: { annotationEditorUIManager: manager } } };
      const state = {
        app, activeDocumentId: "doc-1", activeOpenRequest: 4, disposed: false,
        revision: 12, confirmedRevision: 11, dirty: true, autoSavePending: false,
        autoSaveEnabled: true, autoSavePaused: false, pendingInkCommit: false,
        freeTextFocused: false, freeTextInputPending: false, freeTextCommitReady: false,
        preparingContentForSave: false, closeControl: null, syncCheckpointPromise: null,
        syncApplyControl: null, syncCheckpointInProgress: false,
        annotationTrackingFailure: null, savePromise: null,
      };
      function isInputBusy() { return false; }
      function isDirty() { return true; }
      function clearAutoSaveTimer() {}
      function deferManualSave() { throw new Error("unexpected deferral"); }
      function scheduleAutoSave() {}
      function runSaveSequence() { throw new Error("save sequence must not start"); }
      function isAutoSaveSessionCurrent() { return true; }
      function waitForInputBoundary() { return Promise.resolve(true); }
      function runtimeLogRecord(kind, fields) { messages.push({ type: kind, ...fields }); }
      function runtimeLogError(error) { return error; }
      function sendError(message, fields) { errors.push({ message, fields }); }
      function postToHost(type, fields) { messages.push({ type, ...fields }); return true; }
    `,
    ["state", "messages", "errors"],
  );

  assert.equal(await requestSave("manual"), false);
  assert.equal(state.confirmedRevision, 11);
  assert.equal(state.autoSavePaused, true);
  assert.equal(errors.at(-1)?.fields?.code, "annotation-editor-commit-failed");

  state.autoSavePaused = false;
  assert.equal(await runAutoSaveAfterIdle({ documentId: "doc-1" }), false);
  assert.equal(state.confirmedRevision, 11);
  assert.equal(state.autoSavePaused, true);

  state.autoSavePaused = false;
  await handleExportCopy({ requestId: "export-1", documentId: "doc-1", openRequest: 4 });
  assert.ok(messages.some((message) => message.type === "export-error" && message.requestId === "export-1"));
  assert.equal(messages.some((message) => message.type === "export-ready"), false);
  assert.equal(state.confirmedRevision, 11);
});

test("pointer cleanup observer failures still release capture and clear pointers", () => {
  const { finishTrackedPointer, onBridgePointerEnd, onBridgePointerOut,
    onBridgeLostPointerCapture, pointers, penPolicyPointers, released, queued,
    state, addPointer, addPenPolicyPointer } = evaluateHelpers(
    ["recordAnnotationTrackingFailure", "runAnnotationObserver", "releasePointerCapture",
      "finishTrackedPointer", "onBridgePointerEnd", "onBridgePointerOut",
      "onBridgeLostPointerCapture"],
    `
      const pointers = new Map();
      const penPolicyPointers = new Set();
      const queued = [];
      const released = [];
      const state = { inputRouter: {
          releasePointerCapture(pointerId) { released.push(pointerId); },
          hasPointerCapture() { return false; },
        },
        inputPolicy: { refreshPenGestureTouchAction() {
          if (state.inputPolicy.failTouchActionRefreshOnce) {
            state.inputPolicy.failTouchActionRefreshOnce = false;
            throw new Error("touch-action observer injection");
          }
        } }, annotationTrackingFailure: null,
        iosDirectManipulationController: {
          handlePointerEnd() { return false; },
          handlePointerOut() { return false; },
          handleLostPointerCapture() { return false; },
        },
        pendingInkCommit: false, autoSavePending: false, manualSaveQueued: false,
        closeControl: null, freeTextFocused: false };
      function activePointer(pointerId) { return pointers.get(pointerId); }
      function deleteActivePointer(pointerId) { pointers.delete(pointerId); }
      function hasPenPolicyPointer(pointerId) { return penPolicyPointers.has(pointerId); }
      function deletePenPolicyPointer(pointerId) { penPolicyPointers.delete(pointerId); }
      function invalidatePendingPenHighlight() {}
      function cancelPdfJsPointerSession() { throw new Error("cancel observer injection"); }
      function finishPenHighlightFallback(pointer) {
        if (pointer.pointerId === 42) throw new Error("highlight observer injection");
      }
      function recordPointerDiagnostic() {}
      function activePointerCount() { return pointers.size; }
      function hasActivePointerInteraction() { return pointers.size > 0; }
      function isInputBusy() { return false; }
      function resolveInputBoundaryWaiters() {}
      function runQueuedManualSave() {}
      function scheduleAutoSave() {}
      function syncBridgeControls() {}
      function commitFocusedFreeText() {}
      function setDeferredTimeout(callback) { queued.push(callback); }
      function runtimeLogRecord() {}
      function runtimeLogError(error) { return error; }
      function addPointer(pointerId) {
        pointers.set(pointerId, { pointerId, ending: false, button: 0, mode: 0,
          buttons: 1, penTextSelectionCandidate: false });
      }
      function addPenPolicyPointer(pointerId) { penPolicyPointers.add(pointerId); }
    `,
    ["pointers", "penPolicyPointers", "released", "queued", "state", "addPointer", "addPenPolicyPointer"],
  );

  addPointer(41);
  finishTrackedPointer(41, "pointercancel", null, { cancel: true });
  queued.shift()();
  assert.equal(pointers.size, 0);
  assert.ok(released.includes(41));
  assert.equal(state.annotationTrackingFailure?.phase, "pointer.cancel");

  addPointer(42);
  finishTrackedPointer(42, "pointerup", { buttons: 0 }, { cancel: false });
  queued.shift()();
  assert.equal(pointers.size, 0);
  assert.ok(released.includes(42));
  assert.equal(state.annotationTrackingFailure?.phase, "pointer.highlight-end");

  addPointer(43);
  state.inputPolicy.failTouchActionRefreshOnce = true;
  assert.doesNotThrow(() => onBridgePointerEnd({
    type: "pointerup", pointerId: 43, buttons: 0,
  }, {}));
  queued.shift()();
  assert.equal(pointers.size, 0,
    "touch-action refresh failure at pointer end must not retain the active pointer");
  assert.ok(released.includes(43),
    "touch-action refresh failure at pointer end must not retain pointer capture");
  assert.equal(state.annotationTrackingFailure?.phase, "pointer.touch-action-end");

  addPointer(44);
  addPenPolicyPointer(44);
  state.inputPolicy.failTouchActionRefreshOnce = true;
  assert.doesNotThrow(() => onBridgePointerOut({
    type: "pointerout", pointerId: 44, relatedTargetPresent: false,
  }, {}));
  queued.shift()();
  assert.equal(pointers.size, 0,
    "touch-action refresh failure on pointerout must not retain the active pointer");
  assert.ok(released.includes(44),
    "touch-action refresh failure on pointerout must not retain pointer capture");

  addPointer(45);
  state.inputPolicy.failTouchActionRefreshOnce = true;
  assert.doesNotThrow(() => onBridgeLostPointerCapture({
    type: "lostpointercapture", pointerId: 45,
  }, {}));
  queued.shift()();
  assert.equal(pointers.size, 0,
    "touch-action refresh failure on lostpointercapture must not retain the active pointer");
  assert.ok(released.includes(45),
    "touch-action refresh failure on lostpointercapture must not retain pointer capture");
});
