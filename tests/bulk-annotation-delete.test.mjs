import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const bridge = await readFile(
  new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const start = bridge.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing ${name}`);
  const body = bridge.indexOf(") {", start) + 2;
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = body; index < bridge.length; index += 1) {
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
    if (["'", "\"", "`"].includes(char)) {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return (bridge.slice(start - 6, start) === "async " ? "async " : "") + bridge.slice(start, index + 1);
  }
  throw new Error(`Unterminated ${name}`);
}

test("bulk target planning ignores acknowledged stale upserts but includes dirty local upserts", () => {
  const program = `(() => {
    const state = {
      externalAnnotationRows: new Map([[
        "acknowledged-stale",
        { uuid: "acknowledged-stale", deleted: true },
      ]]),
      annotationSnapshot: new Map(),
      annotationOperations: [
        {
          operation: {
            uuid: "acknowledged-stale",
            pageIndex: 3,
            kind: "Ink",
            deleted: false,
            payload: { editor: { pageIndex: 3, paths: [[1, 2, 3, 4]] } },
          },
        },
        {
          operation: {
            uuid: "dirty-local",
            pageIndex: 8,
            kind: "Ink",
            deleted: false,
            payload: { editor: { pageIndex: 8, paths: [[5, 6, 7, 8]] } },
          },
        },
      ],
      dirtyAnnotationRevisions: new Map([["dirty-local", 12]]),
      dirtyNewAnnotationIds: new Set(["dirty-local"]),
      dirtyDeletedAnnotationIds: new Set(),
      pendingBulkDeletedUuids: new Set(),
      embeddedDeletionTargets: new Map(),
      annotationUuidByPdfRef: new Map(),
    };
    const EXTERNAL_ANNOTATION_KINDS = new Set(["Ink"]);
    function normalizeSyncKind(kind) { return kind; }
    function canonicalPdfAnnotationRef(ref) { return ref || null; }
    ${extractFunction("externalAnnotationMaskRows")}
    ${extractFunction("collectKnownAnnotationDeletionTargets")}
    return collectKnownAnnotationDeletionTargets();
  })()`;
  const targets = vm.runInNewContext(program);

  assert.equal(targets.has("acknowledged-stale"), false,
    "an acknowledged upsert cannot override the external tombstone");
  assert.equal(targets.size, 1);
  assert.equal(targets.has("dirty-local"), true,
    "a genuinely dirty local upsert remains a deletion target");
  assert.deepEqual(JSON.parse(JSON.stringify(targets.get("dirty-local").editorPayload)), {
    pageIndex: 8,
    paths: [[5, 6, 7, 8]],
  });
});

test("offscreen sidecar bulk delete records tombstone and undo/redo each become autosaved revisions", () => {
  const program = `(() => {
    const state = {
      revision: 4,
      activeDocumentId: "document-a",
      disposed: false,
      annotationOperations: [],
      dirtyAnnotationRevisions: new Map(),
      dirtyPageRevisions: new Map(),
      dirtyNewAnnotationIds: new Set(),
      dirtyDeletedAnnotationIds: new Set(),
      pendingBulkDeletedUuids: new Set(),
      embeddedDeletionTargets: new Map(),
      annotationUuidByPdfRef: new Map(),
    };
    const deferred = [];
    let savesScheduled = 0;
    let stamp = 10;
    function markDirtyAnnotation(uuid, pageIndex, action, revision, isNew) {
      state.dirtyAnnotationRevisions.set(uuid, revision);
      state.dirtyPageRevisions.set(pageIndex, revision);
      if (isNew) state.dirtyNewAnnotationIds.add(uuid);
      if (action === "delete") state.dirtyDeletedAnnotationIds.add(uuid);
      else state.dirtyDeletedAnnotationIds.delete(uuid);
    }
    function replaceAnnotationOperation(operation, revision) {
      state.annotationOperations = state.annotationOperations.filter((entry) => entry.operation.uuid !== operation.uuid);
      state.annotationOperations.push({ revision, operation });
      markDirtyAnnotation(operation.uuid, operation.pageIndex, operation.deleted ? "delete" : "upsert", revision, false);
    }
    function createManagedAnnotationOperation(target, deleted) {
      return {
        uuid: target.uuid,
        pageIndex: target.pageIndex,
        kind: target.kind,
        deleted,
        action: deleted ? "delete" : "upsert",
        timestamp: ++stamp,
        logical: stamp,
        deviceId: "test-device",
        operationId: "op-" + stamp,
        serialized: deleted ? { deleted: true } : target.editorPayload,
        payload: deleted ? null : { editor: target.editorPayload },
      };
    }
    function noteMutation() { state.revision += 1; savesScheduled += 1; }
    function syncBridgeControls() {}
    function setDeferredTimeout(callback) { deferred.push(callback); }
    function hydrateExternalAnnotationsForPage() { return Promise.resolve(true); }
    function runtimeLogRecord() {}
    function runtimeLogError(error) { return String(error); }
    ${extractFunction("applySidecarBulkDelete")}
    ${extractFunction("addSidecarBulkDeleteUndoCommand")}
    const commands = [];
    const manager = {
      addCommands(command) {
        commands.push(command);
        if (command.mustExec) command.cmd();
        noteMutation(); // Mirrors observeEditorManager's initial command hook.
      },
    };
    const target = {
      uuid: "annotation-a",
      pageIndex: 17,
      kind: "Ink",
      editorPayload: { pageIndex: 17, paths: [[1, 2, 3, 4]] },
    };
    addSidecarBulkDeleteUndoCommand(manager, [target]);
    return { state, commands, deferred, getSavesScheduled: () => savesScheduled };
  })()`;
  const result = vm.runInNewContext(program);
  assert.equal(result.state.revision, 5);
  assert.equal(result.commands.length, 1);
  assert.equal(result.state.annotationOperations.at(-1).operation.deleted, true);
  assert.deepEqual([...result.state.pendingBulkDeletedUuids], ["annotation-a"]);

  result.commands[0].undo();
  assert.equal(result.state.revision, 6, "undo advances the revision even though the editor was offscreen");
  assert.equal(result.state.annotationOperations.at(-1).operation.deleted, false);
  assert.deepEqual([...result.state.pendingBulkDeletedUuids], []);

  result.commands[0].cmd();
  assert.equal(result.state.revision, 7, "redo advances the revision and stays eligible for save capture");
  assert.equal(result.state.annotationOperations.at(-1).operation.deleted, true);
  assert.deepEqual([...result.state.pendingBulkDeletedUuids], ["annotation-a"]);
  assert.equal(result.getSavesScheduled(), 3);
});
test("all-page confirmation is canceled on session change and renewed after target drift", async () => {
  const program = `(() => {
    const state = {
      activeDocumentId: "document-a",
      activeOpenRequest: 1,
      requestedOpenRequest: 1,
      disposed: false,
      ready: true,
      app: {
        pdfDocument: {},
        pdfViewer: { _layerProperties: { annotationEditorUIManager: {} } },
      },
      bulkDeleteDialog: null,
      embeddedDeletionTargets: new Map(),
      embeddedDeletionScan: null,
      openQueue: Promise.resolve(),
      queuedOpens: [],
    };
    const created = [];
    const knownTargets = new Map([["one", {}], ["two", {}]]);
    const deleteCalls = [];
    const statuses = [];
    function makeElement(tagName) {
      const listeners = new Map();
      const element = {
        tagName,
        className: "",
        children: [],
        isConnected: false,
        setAttribute() {},
        append(...children) {
          this.children.push(...children);
          if (this.isConnected) for (const child of children) connect(child);
        },
        addEventListener(name, listener) { listeners.set(name, listener); },
        remove() { disconnect(this); },
        focus() { document.activeElement = this; },
        click() { listeners.get("click")?.({ target: this }); },
        querySelectorAll() { return this.children.flatMap((child) => [child, ...child.children]); },
      };
      created.push(element);
      return element;
    }
    function connect(element) {
      element.isConnected = true;
      for (const child of element.children) connect(child);
    }
    function disconnect(element) {
      element.isConnected = false;
      for (const child of element.children) disconnect(child);
    }
    const document = {
      activeElement: null,
      createElement: makeElement,
      body: makeElement("body"),
    };
    document.body.append = (...children) => {
      document.body.children.push(...children);
      for (const child of children) connect(child);
    };
    function collectKnownAnnotationDeletionTargets() { return knownTargets; }
    function showStatus(message) { statuses.push(message); }
    const rendererGeneration = 7;
    const VOCABULARY_DISPLAY_MODES = ["all", "learning", "focus"];
    function requestManagedAnnotationDeletion(pageIndex, session) {
      if (isCurrentBulkDeleteSession(session)) deleteCalls.push({ pageIndex, session });
    }
    async function openDocument(message) {
      state.activeDocumentId = message.documentId;
      state.activeOpenRequest = message.openRequest;
      state.app = {
        pdfDocument: {},
        pdfViewer: { _layerProperties: { annotationEditorUIManager: {} } },
      };
    }
    function sendError() {}
    ${extractFunction("captureBulkDeleteSession")}
    ${extractFunction("isCurrentBulkDeleteSession")}
    ${extractFunction("prepareEmbeddedDeletionTargets")}
    ${extractFunction("showDeleteAllAnnotationsConfirmation")}
    ${extractFunction("normalizeVocabularyDisplayMode")}
    function syncVocabularyDisplayModeButton() {}
    ${extractFunction("setVocabularyDisplayMode")}
    ${extractFunction("normalizeVocabularyHighlightLevels")}
    ${extractFunction("setVocabularyHighlightLevels")}
    ${extractFunction("queueOpen")}
    globalThis.api = {
      state,
      created,
      knownTargets,
      deleteCalls,
      statuses,
      showDeleteAllAnnotationsConfirmation,
      queueOpen,
    };
    return globalThis.api;
  })()`;
  const result = vm.runInNewContext(program);
  const find = (id) => result.created.filter((element) => element.id === id).at(-1);

  await result.showDeleteAllAnnotationsConfirmation();
  const staleConfirm = result.created.find((element) => element.className === "pdfReaderBulkDeleteConfirm");
  assert.ok(staleConfirm);
  result.queueOpen({ documentId: "document-b", openRequest: 2 });
  await result.state.openQueue;
  assert.equal(result.state.bulkDeleteDialog, null, "queueing a new open closes the old dialog");
  staleConfirm.click();
  assert.equal(result.deleteCalls.length, 0, "a detached stale confirm cannot target the newly opened document");

  await result.showDeleteAllAnnotationsConfirmation();
  const confirm = result.created.filter((element) => element.className === "pdfReaderBulkDeleteConfirm").at(-1);
  result.knownTargets.set("three", {});
  confirm.click();
  assert.equal(result.deleteCalls.length, 0, "target drift requires a fresh confirmation");
  assert.match(find("pdfReaderBulkDeleteDescription").textContent, /列表已变化.*3 条/);
  assert.ok(result.state.bulkDeleteDialog, "the updated confirmation stays open for review");
  confirm.click();
  assert.equal(result.state.bulkDeleteDialog, null);
  assert.equal(result.deleteCalls.length, 1);
  assert.equal(result.deleteCalls[0].pageIndex, null);
  assert.equal(result.deleteCalls[0].session.documentId, "document-b");
  assert.equal(result.deleteCalls[0].session.openRequest, 2);
});

test("bulk deletion recognizes confirmed hydrated editors even when unchanged serialization is null", () => {
  const result = vm.runInNewContext(`(() => {
    const editor = { id: "hydrated-runtime", pageIndex: 16, deleted: false,
      serialize() { return null; } };
    const target = { uuid: "persisted-annotation", pageIndex: 16, kind: "Ink", editorPayload: { pageIndex: 16 } };
    const manager = { getEditors: (page) => page === 16 ? [editor] : [],
      getEditor: (id) => id === editor.id ? editor : null };
    const state = { app: { pdfDocument: { numPages: 357 }, pdfViewer: { _layerProperties: { annotationEditorUIManager: manager } } },
      annotationUuidByRuntimeId: new Map([[editor.id, target.uuid]]),
      externalAnnotationHydration: new Map([[target.uuid, { runtimeId: editor.id, pageIndex: 16 }]]) };
    function collectKnownAnnotationDeletionTargets() { return new Map([[target.uuid, target]]); }
    function getAnnotationStorageRows() { return new Map(); }
    function normalizeSyncKind(kind) { return kind; }
    function canonicalPdfAnnotationRef(ref) { return ref || null; }
    const EXTERNAL_ANNOTATION_KINDS = new Set(["Ink"]);
    ${extractFunction("collectManagedAnnotationDeletionPlan")}
    return collectManagedAnnotationDeletionPlan();
  })()`);
  assert.equal(result.targets.size, 1);
  assert.equal(result.liveEditors.length, 1, "unchanged persisted editors still participate in grouped deletion");
  assert.equal(result.sidecarOnly.length, 0);
});

test("sidebar deletion plan contains only explicitly selected UUIDs", () => {
  const result = vm.runInNewContext(`(() => {
    const a = { uuid: "a", pageIndex: 0, kind: "Ink", editorPayload: { pageIndex: 0 } };
    const b = { uuid: "b", pageIndex: 1, kind: "Ink", editorPayload: { pageIndex: 1 } };
    const manager = { getEditors: () => [], getEditor: () => null };
    const state = { app: { pdfDocument: {}, pdfViewer: { _layerProperties: { annotationEditorUIManager: manager } } },
      externalAnnotationHydration: new Map(), annotationUuidByRuntimeId: new Map() };
    function collectKnownAnnotationDeletionTargets() { return new Map([["a", a], ["b", b]]); }
    function getAnnotationStorageRows() { return new Map(); }
    ${extractFunction("collectManagedAnnotationDeletionPlan")}
    return collectManagedAnnotationDeletionPlan(null, new Set(["b"]));
  })()`);
  assert.deepEqual([...result.targets.keys()], ["b"]);
  assert.deepEqual(Array.from(result.sidecarOnly, (item) => item.uuid), ["b"]);
});

test("a stale live snapshot cannot replace a pending bulk tombstone with an upsert", () => {
  const result = vm.runInNewContext(`(() => {
    const deleted = { uuid: "already-deleted", pageIndex: 2, kind: "Ink", action: "delete", deleted: true };
    const before = { uuid: deleted.uuid, runtimeId: "old-editor", pageIndex: 2, signature: "before" };
    const after = { ...before, signature: "stale-after", value: { pageIndex: 2 } };
    const state = { app: {}, revision: 9, annotationSnapshot: new Map([["old-editor", before]]),
      annotationOperations: [{ revision: 9, operation: deleted }],
      pendingBulkDeletedUuids: new Set([deleted.uuid]), dirtyPageRevisions: new Map(),
      restoredSavedAnnotations: new Map() };
    function getAnnotationStorageRows() { return new Map([["old-editor", after]]); }
    function markDirtyAnnotation() { throw new Error("must not replace the explicit delete"); }
    function makeSyncStamp() { throw new Error("must not stamp a stale upsert"); }
    ${extractFunction("refreshAnnotationOperations")}
    refreshAnnotationOperations(10, { includeLiveEditors: true });
    return state;
  })()`);
  assert.equal(result.annotationOperations.length, 1);
  assert.equal(result.annotationOperations[0].operation.action, "delete");
  assert.equal(result.annotationOperations[0].revision, 9);
});

test("bulk delete guards every live and sidecar target with the same tombstone", () => {
  const result = vm.runInNewContext(`(() => {
    const state = {
      revision: 4, app: null, annotationOperations: [], externalAnnotationRows: new Map(),
      dirtyAnnotationRevisions: new Map(), dirtyPageRevisions: new Map(),
      dirtyNewAnnotationIds: new Set(), dirtyDeletedAnnotationIds: new Set(),
      pendingBulkDeletedUuids: new Set(), annotationUuidByPdfRef: new Map(),
      annotationSnapshot: new Map(), restoredSavedAnnotations: new Map(),
    };
    let clock = 20;
    function pdfAnnotationRefKey(ref) { return String(ref); }
    function createManagedAnnotationOperation(target, deleted) {
      const timestamp = ++clock;
      return { uuid: target.uuid, pageIndex: target.pageIndex, kind: target.kind,
        deleted, action: deleted ? "delete" : "upsert", timestamp,
        logical: timestamp, deviceId: "device", operationId: "op-" + timestamp };
    }
    function markDirtyAnnotation(uuid, pageIndex, action, revision) {
      state.dirtyAnnotationRevisions.set(uuid, revision);
      state.dirtyPageRevisions.set(pageIndex, revision);
      if (action === "delete") state.dirtyDeletedAnnotationIds.add(uuid);
    }
    function replaceAnnotationOperation(operation, revision) {
      state.annotationOperations = state.annotationOperations.filter((entry) => entry.operation.uuid !== operation.uuid);
      state.annotationOperations.push({ revision, operation });
      markDirtyAnnotation(operation.uuid, operation.pageIndex, operation.deleted ? "delete" : "upsert", revision);
    }
    function syncBridgeControls() {}
    function noteMutation() { state.revision += 1; }
    function getAnnotationStorageRows() {
      return new Map([
        ["runtime-live", { uuid: "live-editor", pageIndex: 1, kind: "Ink", signature: "stale-live" }],
        ["runtime-sidecar", { uuid: "sidecar-only", pageIndex: 2, kind: "Highlight", signature: "stale-sidecar" }],
      ]);
    }
    function makeSyncStamp() { throw new Error("stale snapshots must not emit operations"); }
    function normalizeSyncKind(kind) { return kind; }
    const EXTERNAL_ANNOTATION_KINDS = new Set(["Ink", "Highlight"]);
    ${extractFunction("applySidecarBulkDelete")}
    ${extractFunction("applyManagedBulkDelete")}
    ${extractFunction("refreshAnnotationOperations")}
    const plan = { targets: new Map([
      ["live-editor", { uuid: "live-editor", pageIndex: 1, kind: "Ink", editorPayload: { paths: [1] } }],
      ["sidecar-only", { uuid: "sidecar-only", pageIndex: 2, kind: "Highlight", editorPayload: { rect: [1, 2, 3, 4] } }],
    ]), liveEditors: [{}], sidecarOnly: [] };
    applyManagedBulkDelete(plan, true);
    refreshAnnotationOperations(state.revision + 1);
    return state;
  })()`);
  assert.deepEqual([...result.pendingBulkDeletedUuids].sort(), ["live-editor", "sidecar-only"]);
  assert.equal(result.annotationOperations.filter(({ operation }) => operation.action === "delete").length, 2);
  assert.equal(result.externalAnnotationRows.get("live-editor").deleted, true);
  assert.equal(result.externalAnnotationRows.get("sidecar-only").deleted, true);
});

test("only the acknowledged delete revision releases the local bulk tombstone guard", () => {
  const result = vm.runInNewContext(`(() => {
    const state = { dirtyAnnotationRevisions: new Map([["deleted", 12]]),
      dirtyPageRevisions: new Map([[2, 12]]), dirtyNewAnnotationIds: new Set(),
      dirtyDeletedAnnotationIds: new Set(["deleted"]), pendingBulkDeletedUuids: new Set(["deleted"]) };
    ${extractFunction("clearConfirmedDirtyState")}
    clearConfirmedDirtyState(11);
    const retained = state.pendingBulkDeletedUuids.has("deleted");
    clearConfirmedDirtyState(12);
    return { retained, released: !state.pendingBulkDeletedUuids.has("deleted"), dirty: state.dirtyAnnotationRevisions.size };
  })()`);
  assert.equal(result.retained, true);
  assert.equal(result.released, true);
  assert.equal(result.dirty, 0);
});
