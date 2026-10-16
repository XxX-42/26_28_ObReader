import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { readBridgeRuntimeSource } from "./bridge-runtime-source.mjs";

const bridgePath = new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url);
const bridge = await readBridgeRuntimeSource(bridgePath);

function functionSource(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(bridge);
  assert.ok(match, `missing function ${name}`);
  const start = match.index;
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeHarness({ deserialize, onReadOnly } = {}) {
  const source = [
    "normalizeSyncKind",
    "externalKindForEditor",
    "decodeExternalValue",
    "normalizeSyncValue",
    "applyLegacyAnnotationIdentities",
    "canonicalPdfAnnotationRef",
    "pdfAnnotationRefKey",
    "annotationRowsChanged",
    "snapshotChanges",
    "restoreChanges",
    "captureDirtySyncState",
    "externalAnnotationMatchesClock",
    "findUuidMappedEditors",
    "externalAnnotationMatchesLocalOperation",
    "sameAnnotationPayload",
    "addHydratedEditor",
    "hydrateExternalAnnotation",
    "hydrateExternalAnnotationsForPage",
    "applyExternalAnnotationsSnapshot",
    "externalSourceIdentityMatchesViewer",
    "schedulePendingExternalAnnotationUpdate",
  ].map(functionSource);
  const walValidatorSource = functionSource("validateExternalAnnotations")
    .replace("function validateExternalAnnotations(", "function validateWalExternalAnnotations(");
  source.push(walValidatorSource);
  const executableSource = source.join("\n");

  const context = vm.createContext({ onReadOnly, deserialize });
  return vm.runInContext(`(() => {
    const timers = [];
    const editorById = new Map();
    const editorIdsByPage = new Map();
    const storageRows = new Map();
    const state = {
      app: null,
      disposed: false,
      pendingExternalAnnotationsUpdate: null,
      activeDocumentId: "document-a",
      activeOpenRequest: "open-a",
      externalSourceConfirmed: true,
      actualSourceIdentity: {
        identityStatus: "KNOWN",
        pageCount: 1,
        orderedPageIdentities: ["page-hash-a"],
        sourceHash: "source-hash-a",
      },
      externalAnnotationRows: new Map(),
      externalAnnotationHydration: new Map(),
      externalAnnotationRefs: new Set(),
      externalSource: null,
      compactInkEncoding: false,
      hydratingExternalAnnotations: false,
      pendingInkCommit: false,
      revision: 4,
      dirty: false,
      dirtyAnnotationRevisions: new Map(),
      dirtyPageRevisions: new Map(),
      dirtyNewAnnotationIds: new Set(),
      dirtyDeletedAnnotationIds: new Set(),
      pendingBulkDeletedUuids: new Set(),
      annotationSnapshot: new Map([["confirmed-before", { uuid: "already-confirmed" }]]),
      annotationOperations: [],
      annotationUuidByRuntimeId: new Map(),
      annotationRefByRuntimeId: new Map(),
      annotationUuidByPdfRef: new Map(),
    };
    let editBusy = false;
    let resetModifiedCalls = 0;
    let noteMutationCalls = 0;
    const app = {
      pdfDocument: {
        numPages: 1,
        annotationStorage: {
          serializable: { map: storageRows },
          resetModified() { resetModifiedCalls += 1; },
        },
      },
      pdfViewer: {
        getPageView() {
          return { annotationEditorLayer: { annotationEditorLayer: true, show() {} } };
        },
      },
      _annotationStorageModified: false,
      _captureDirtySnapshot() {
        return { hadAnnotationChanges: !!this._annotationStorageModified, hadStructuralChanges: false };
      },
      _restoreDirtySnapshot(snapshot) {
        this._annotationStorageModified = snapshot.hadAnnotationChanges;
      },
    };
    state.app = app;

    const manager = {
      getEditor(id) { return editorById.get(String(id)) || null; },
      getEditors(pageIndex) { return editorIdsByPage.get(pageIndex) || []; },
      add(editor) {
        editorById.set(String(editor.id), editor);
        const editors = editorIdsByPage.get(editor.pageIndex) || [];
        if (!editors.includes(editor)) editors.push(editor);
        editorIdsByPage.set(editor.pageIndex, editors);
      },
      remove(editor) {
        editorById.delete(String(editor.id));
        const editors = editorIdsByPage.get(editor.pageIndex) || [];
        editorIdsByPage.set(editor.pageIndex, editors.filter((candidate) => candidate !== editor));
        storageRows.delete(String(editor.id));
      },
    };
    let nextEditorId = 100;
    let deserializeCalls = 0;
    const layer = {
      async deserialize(payload) {
        deserializeCalls += 1;
        if (deserialize) return deserialize(payload);
        return makeEditor("hydrated-" + ++nextEditorId, payload.pageIndex, payload);
      },
      add(editor) {
        manager.add(editor);
        storageRows.set(String(editor.id), { uuid: state.annotationUuidByRuntimeId.get(String(editor.id)), signature: JSON.stringify(editor.payload) });
      },
    };
    function makeEditor(id, pageIndex, payload = {}) {
      const editor = {
        id,
        pageIndex,
        editorType: "Square",
        payload,
        serialize() { return payload; },
        remove() { manager.remove(editor); },
      };
      return editor;
    }
    function getAnnotationEditorManager() { return manager; }
    function getAnnotationEditorLayer() { return layer; }
    function suppressEmbeddedAnnotation() { return true; }
    function setDeferredTimeout(callback) { timers.push(callback); return timers.length; }
    function isEditBoundaryBusy() { return editBusy; }
    function setReadOnlyState(value) { state.readOnly = value; onReadOnly?.(value); }
    function scheduleExternalAnnotationHydrationRetry() {}
    function sendError(message) { throw new Error(message); }
    function runtimeLogRecord() {}
    function runtimeLogError(error) { return { message: String(error?.message || error) }; }
    function noteMutation() { noteMutationCalls += 1; }
    function seedSyncClock() {}
    function encodeExternalValue(value) { return value; }
    const EXTERNAL_ANNOTATION_KINDS = new Set([
      "Underline", "Square", "Highlight", "Ink", "InkHighlight", "FreeText",
    ]);
    function validateExternalAnnotations(value) {
      return value?.storageProtocol === "wal-sidecar-v3.1"
        ? validateWalExternalAnnotations(value)
        : value;
    }
    function compareSyncStamps(left, right) {
      for (const key of ["timestamp", "logical"]) {
        if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
      }
      for (const key of ["actorId", "operationId"]) {
        const a = String(left[key] || "");
        const b = String(right[key] || "");
        if (a !== b) return a > b ? 1 : -1;
      }
      return 0;
    }
    function getAnnotationStorageRows() {
      return new Map([...storageRows].map(([id, row]) => [String(id), {
        ...row,
        uuid: row.uuid || state.annotationUuidByRuntimeId.get(String(id)) || null,
        runtimeId: String(id),
      }]));
    }
    function addStorageRow(runtimeId, uuid, signature = uuid) {
      storageRows.set(String(runtimeId), { uuid, signature });
    }
    function addEditor(editor) {
      manager.add(editor);
      return editor;
    }
    function markDirty(uuid, revision) {
      state.dirty = true;
      state.revision = revision;
      state.dirtyAnnotationRevisions.set(uuid, revision);
      state.dirtyPageRevisions.set(0, revision);
      state.dirtyNewAnnotationIds.add(uuid);
      app._annotationStorageModified = true;
    }
    function setBusy(value) { editBusy = value; }
    function fireNextTimer() {
      const callback = timers.shift();
      if (!callback) throw new Error("No deferred timer was scheduled.");
      callback();
    }
    ${executableSource}
    return {
      state, app, manager, layer, timers, resetModifiedCalls,
      addStorageRow, addEditor, markDirty, setBusy, fireNextTimer,
      getEditor: (id) => editorById.get(String(id)) || null,
      getStorageRows: () => getAnnotationStorageRows(),
      getDeserializeCalls: () => deserializeCalls,
      getNoteMutationCalls: () => noteMutationCalls,
      hydrateExternalAnnotation, hydrateExternalAnnotationsForPage,
      applyExternalAnnotationsSnapshot,
      schedulePendingExternalAnnotationUpdate,
      getResetModifiedCalls: () => resetModifiedCalls,
    };
  })()`, context);
}

function remoteRow({ uuid = "remote-square", timestamp = 20, opId = "remote-op-20", editor = { rect: [1, 2, 30, 40] } } = {}) {
  return {
    uuid,
    kind: "Square",
    pageIndex: 0,
    embeddedRef: null,
    deleted: false,
    clock: { timestamp, logical: 0, deviceId: "remote-device", opId },
    editor,
  };
}

function snapshot(annotations = [remoteRow()]) {
  return {
    source: {
      pageCount: 1,
      orderedPageIdentities: ["page-hash-a"],
      sourceHash: "source-hash-a",
    },
    legacyIdentities: [],
    annotations,
    compactInkEncoding: false,
  };
}

function walSnapshot(rows) {
  return {
    schemaVersion: 1,
    storageProtocol: "wal-sidecar-v3.1",
    source: {
      pageCount: 1,
      orderedPageIdentities: ["page-hash-a"],
      sourceHash: "source-hash-a",
    },
    legacyIdentities: [],
    annotations: rows.map(({ uuid, timestamp, opId, rect }) => ({
      uuid,
      kind: "Square",
      pageIndex: 0,
      embeddedRef: null,
      deleted: false,
      clock: { timestamp, logical: 0, deviceId: "wal-device", opId },
      payload: { editor: { pageIndex: 0, type: "Square", rect } },
    })),
  };
}

test("a queued snapshot and awaited hydration cannot baseline or clear a concurrent local stroke", async () => {
  const hydration = deferred();
  const deserializeStarted = deferred();
  const updateFinished = deferred();
  const harness = makeHarness({
    onReadOnly: () => updateFinished.resolve(),
    deserialize(payload) {
      deserializeStarted.resolve();
      return hydration.promise.then(() => ({
        id: "hydrated-remote",
        pageIndex: payload.pageIndex,
        payload,
        serialize() { return payload; },
        remove() {},
      }));
    },
  });
  const { state, app } = harness;
  harness.addStorageRow("confirmed-runtime", "already-confirmed");
  state.annotationSnapshot = harness.getStorageRows();
  app._restoreDirtySnapshot = function (snapshot) {
    this._annotationStorageModified = snapshot.hadAnnotationChanges;
  };
  state.pendingExternalAnnotationsUpdate = {
    documentId: "document-a",
    openRequest: "open-a",
    identityConfirmed: true,
    externalAnnotations: snapshot(),
  };
  state.app._annotationStorageModified = false;
  harness.schedulePendingExternalAnnotationUpdate();

  // The user starts a second Square after the callback is queued. The row has
  // entered AnnotationStorage, but no save/diff has confirmed it yet.
  harness.addStorageRow("local-square-before-timeout", "local-square-before-timeout");
  harness.setBusy(true);
  harness.fireNextTimer();
  assert.equal(state.pendingExternalAnnotationsUpdate?.documentId, "document-a",
    "a busy callback must retain the queued host update");
  assert.equal(state.externalAnnotationRows.size, 0,
    "a callback that observes active input must not apply its snapshot");
  assert.equal(state.annotationSnapshot.has("local-square-before-timeout"), false,
    "an unconfirmed local row must not become the confirmed baseline");

  // Once the gesture settles, retry the same queued update. Hydration blocks
  // in deserialize while another local stroke advances the revision.
  harness.setBusy(false);
  harness.schedulePendingExternalAnnotationUpdate();
  harness.fireNextTimer();
  await deserializeStarted.promise;
  assert.equal(state.annotationSnapshot.has("local-square-before-timeout"), false,
    "applying the queued sidecar snapshot must not confirm the untracked local row");
  harness.addStorageRow("local-square-during-hydration", "local-square-during-hydration");
  harness.markDirty("local-square-during-hydration", 9);
  hydration.resolve();
  await updateFinished.promise;

  assert.equal(state.dirty, true, "hydrate completion must preserve dirty state");
  assert.equal(state.revision, 9, "hydrate completion must preserve the newer revision");
  assert.equal(state.dirtyAnnotationRevisions.get("local-square-during-hydration"), 9,
    "hydrate completion must preserve the local dirty revision");
  assert.equal(app._annotationStorageModified, true,
    "external hydration must not clear PDF.js's concurrent local modified flag");
  assert.equal(harness.getResetModifiedCalls(), 0,
    "external hydration must not reset PDF.js modified state for unrelated local edits");
  assert.ok(harness.getNoteMutationCalls() > 0,
    "the untracked local row must be surfaced to the ordinary mutation path after hydration");
  assert.ok(state.externalAnnotationHydration.has("remote-square"),
    "the actual remote row should still finish hydration");
});

test("an exact local operation echo is reused even when hydration is asked to replace", async () => {
  const harness = makeHarness();
  const { state } = harness;
  const uuid = "local-square";
  const stamp = { timestamp: 41, logical: 2, deviceId: "device-local", opId: "actor:41:2:3" };
  const localEditor = harness.addEditor({
    id: "local-runtime",
    pageIndex: 0,
    editorType: "Square",
    serialize() { return { rect: [2, 3, 22, 33] }; },
    remove() { harness.manager.remove(this); },
  });
  state.annotationUuidByRuntimeId.set(localEditor.id, uuid);
  state.annotationOperations.push({ operation: {
    uuid,
    timestamp: stamp.timestamp,
    logical: stamp.logical,
    deviceId: stamp.deviceId,
    operationId: stamp.opId,
    action: "upsert",
  } });
  const incoming = remoteRow({ uuid, timestamp: stamp.timestamp, opId: stamp.opId });
  incoming.clock.logical = stamp.logical;
  incoming.clock.deviceId = stamp.deviceId;
  incoming.editor = { rect: [2, 3, 22, 33] };
  state.externalAnnotationHydration.set(uuid, {
    runtimeId: localEditor.id,
    pageIndex: 0,
    embeddedRef: null,
    row: remoteRow({ uuid, timestamp: 40, opId: "older-op" }),
    adoptedEmbedded: false,
  });
  state.externalAnnotationRows.set(uuid, incoming);

  const complete = await harness.hydrateExternalAnnotationsForPage(0);
  assert.equal(complete, true);
  assert.equal(harness.getEditor(localEditor.id), localEditor,
    "the exact-stamp local editor must be reused rather than replaced");
  assert.equal(harness.getDeserializeCalls(), 0,
    "the exact-stamp local echo must not deserialize a replacement");
  assert.equal(state.externalAnnotationHydration.get(uuid).runtimeId, localEditor.id);
  assert.equal(state.externalAnnotationHydration.get(uuid).row.clock.opId, stamp.opId,
    "the adopted binding must advance to the host's exact echoed stamp");
  assert.equal(harness.getResetModifiedCalls(), 0);
});

test("a newer remote operation with a different stamp still replaces the bound editor", async () => {
  const harness = makeHarness();
  const { state } = harness;
  const uuid = "square-with-remote-update";
  const oldRow = remoteRow({ uuid, timestamp: 50, opId: "old-remote-op" });
  const oldEditor = harness.addEditor({
    id: "old-runtime",
    pageIndex: 0,
    editorType: "Square",
    serialize() { return oldRow.editor; },
    remove() { harness.manager.remove(this); },
  });
  state.externalAnnotationHydration.set(uuid, {
    runtimeId: oldEditor.id,
    pageIndex: 0,
    embeddedRef: null,
    row: oldRow,
    adoptedEmbedded: false,
  });
  const incoming = remoteRow({
    uuid,
    timestamp: 51,
    opId: "new-remote-op",
    editor: { rect: [5, 6, 50, 60] },
  });
  state.externalAnnotationRows.set(uuid, incoming);

  const complete = await harness.hydrateExternalAnnotationsForPage(0);
  assert.equal(complete, true);
  assert.equal(harness.getEditor(oldEditor.id), null,
    "a newer nonmatching remote operation must remove the stale binding");
  const binding = state.externalAnnotationHydration.get(uuid);
  assert.ok(binding?.runtimeId);
  assert.notEqual(binding.runtimeId, oldEditor.id,
    "the newer remote operation must install a replacement editor");
  assert.equal(binding.row.clock.opId, "new-remote-op");
  assert.deepEqual(binding.row.editor.rect, [5, 6, 50, 60]);
});

test("authoritative WAL snapshots replace clean stale bindings and defer dirty local UUIDs", async () => {
  const harness = makeHarness();
  const { state } = harness;
  const cleanUuid = "wal-clean-square";
  const oldRow = remoteRow({
    uuid: cleanUuid,
    timestamp: 900,
    opId: "old-high-clock-op",
    editor: { pageIndex: 0, type: "Square", rect: [1, 2, 30, 40] },
  });
  const oldEditor = harness.addEditor({
    id: "old-wal-runtime",
    pageIndex: 0,
    editorType: "Square",
    serialize() { return oldRow.editor; },
    remove() { harness.manager.remove(this); },
  });
  state.externalAnnotationHydration.set(cleanUuid, {
    runtimeId: oldEditor.id,
    pageIndex: 0,
    embeddedRef: null,
    row: oldRow,
    adoptedEmbedded: false,
  });
  state.externalAnnotationRows.set(cleanUuid, oldRow);

  const dirtyUuid = "wal-dirty-square";
  const dirtyEditor = harness.addEditor({
    id: "local-dirty-runtime",
    pageIndex: 0,
    editorType: "Square",
    serialize() { return { pageIndex: 0, type: "Square", rect: [8, 9, 18, 19] }; },
    remove() { harness.manager.remove(this); },
  });
  state.annotationUuidByRuntimeId.set(dirtyEditor.id, dirtyUuid);
  harness.markDirty(dirtyUuid, 12);

  const snapshotResult = harness.applyExternalAnnotationsSnapshot(walSnapshot([
    { uuid: cleanUuid, timestamp: 2, opId: "wal-low-clock-clean", rect: [5, 6, 50, 60] },
    { uuid: dirtyUuid, timestamp: 1, opId: "wal-dirty-must-defer", rect: [90, 91, 100, 101] },
  ]));

  const authoritativeRow = state.externalAnnotationRows.get(cleanUuid);
  assert.equal(authoritativeRow.authoritative, true,
    "the WAL storage protocol must retain authoritative snapshot provenance");
  assert.equal(authoritativeRow.clock.timestamp, 2,
    "the authoritative snapshot is applied even when its wall clock is below the old binding");
  assert.deepEqual(authoritativeRow.editor.rect, [5, 6, 50, 60]);
  assert.deepEqual([...snapshotResult.deferredUuids], [dirtyUuid],
    "a UUID with local dirty state must be deferred from the same snapshot");
  assert.equal(state.externalAnnotationRows.has(dirtyUuid), false,
    "the deferred WAL row must not enter the adopted external snapshot");
  assert.equal(harness.getEditor(dirtyEditor.id), dirtyEditor,
    "deferring the snapshot must preserve the local dirty editor");

  assert.equal(await harness.hydrateExternalAnnotationsForPage(0), true);
  const cleanBinding = state.externalAnnotationHydration.get(cleanUuid);
  assert.notEqual(cleanBinding.runtimeId, oldEditor.id,
    "a different authoritative WAL clock must replace the old hydrated editor despite lower wall time");
  assert.equal(cleanBinding.row.clock.opId, "wal-low-clock-clean");
  assert.equal(harness.getEditor(dirtyEditor.id), dirtyEditor,
    "subsequent hydration must leave the deferred local dirty editor untouched");
});

test("confirmed bulk tombstones remove an already hydrated annotation rather than being filtered out", async () => {
  const harness = makeHarness();
  const { state } = harness;
  const uuid = "bulk-deleted-square";
  const oldRow = remoteRow({ uuid });
  const editor = harness.addEditor({
    id: "bulk-runtime", pageIndex: 0, editorType: "Square",
    serialize() { return oldRow.editor; },
    remove() { harness.manager.remove(this); },
  });
  state.externalAnnotationHydration.set(uuid, { runtimeId: editor.id, pageIndex: 0, row: oldRow });
  state.annotationSnapshot.set(editor.id, { uuid, runtimeId: editor.id });
  state.externalAnnotationRows.set(uuid, { ...oldRow, deleted: true, editor: null });
  state.dirtyAnnotationRevisions.set(uuid, 99);
  assert.equal(await harness.hydrateExternalAnnotationsForPage(0), true);
  assert.equal(harness.getEditor(editor.id), editor,
    "an old tombstone must not erase a newer unconfirmed local undo/edit");
  state.dirtyAnnotationRevisions.clear();
  assert.equal(await harness.hydrateExternalAnnotationsForPage(0), true);
  assert.equal(harness.getEditor(editor.id), null, "the confirmed deletion removes the visible editor");
  assert.equal(state.externalAnnotationHydration.has(uuid), false);
  assert.equal(state.annotationSnapshot.has(editor.id), false);
  assert.equal(harness.getDeserializeCalls(), 0, "a tombstone never creates an editor");
});
