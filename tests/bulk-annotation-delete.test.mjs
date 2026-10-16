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
    if (char === "}" && --depth === 0) return bridge.slice(start, index + 1);
  }
  throw new Error(`Unterminated ${name}`);
}

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
    ${extractFunction("showDeleteAllAnnotationsConfirmation")}
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

  result.showDeleteAllAnnotationsConfirmation();
  const staleConfirm = result.created.find((element) => element.className === "pdfReaderBulkDeleteConfirm");
  assert.ok(staleConfirm);
  result.queueOpen({ documentId: "document-b", openRequest: 2 });
  await result.state.openQueue;
  assert.equal(result.state.bulkDeleteDialog, null, "queueing a new open closes the old dialog");
  staleConfirm.click();
  assert.equal(result.deleteCalls.length, 0, "a detached stale confirm cannot target the newly opened document");

  result.showDeleteAllAnnotationsConfirmation();
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
