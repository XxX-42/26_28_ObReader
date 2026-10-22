import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { VocabularyMemoryAdapter } from "./vocabulary-v2-memory-adapter.mjs";

const require = createRequire(import.meta.url);
const { VocabularyTransactionCoordinator } = require("../plugin/vocabulary/transactions.cjs");
const { VocabularyHistory } = require("../plugin/vocabulary/history.cjs");
const semanticPath = process.env.OBREADER_SEMANTIC_MODULE || fileURLToPath(new URL("../plugin/semantic/semantic-anchor.cjs", import.meta.url));
const domainPath = process.env.OBREADER_LEARNING_WORKSPACE || fileURLToPath(new URL("../plugin/learning/workspace.cjs", import.meta.url));
const semantic = require(semanticPath);
const domain = require(domainPath);
const hostPath = fileURLToPath(new URL("../plugin/learning/host.cjs", import.meta.url));
const hostRequire = createRequire(hostPath);
const hostModule = { exports: {} };
vm.runInNewContext(readFileSync(hostPath, "utf8"), {
  module: hostModule, exports: hostModule.exports,
  require: name => name === "../semantic/semantic-anchor.cjs" ? semantic : name === "./workspace.cjs" ? domain : hostRequire(name),
  Object, Set, Map, Error, TypeError,
}, { filename: hostPath });
const { createLearningHost } = hostModule.exports;

class Element {
  constructor() { this.value = ""; this.children = []; this.textContent = ""; this.listeners = new Map(); }
  empty() { this.children = []; }
  createEl(tag, options = {}) {
    const node = new Element(); node.tag = tag; node.textContent = options.text || "";
    this.children.push(node); return node;
  }
  appendChild(node) { this.children.push(node); }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
}
class Modal {
  constructor() { this.contentEl = new Element(); this.titleEl = new Element(); this.closed = true; }
  open() { this.closed = false; this.onOpen?.(); }
  close() { this.closed = true; this.onClose?.(); }
}

function fixture() {
  const adapter = new VocabularyMemoryAdapter();
  let serial = Promise.resolve(), sequence = 0;
  const coordinator = new VocabularyTransactionCoordinator({ adapter, deviceId: "host-test", sessionId: "host-session",
    makeId: () => `transaction-${++sequence}`, now: () => new Date("2026-10-22T00:00:00.000Z") });
  const history = new VocabularyHistory({ coordinator });
  const contexts = new Map();
  const runtime = { coordinator, history, contexts: {
    getContext: async id => contexts.get(id),
    listFamily: async (familyKey, { limit }) => {
      const rows = [...contexts.values()].filter(row => row.familyKey === familyKey);
      return { contexts: rows.slice(0, limit), total: rows.length, nextCursor: rows.length > limit ? "next" : null };
    },
  }, exclusive(task) {
    const pending = serial.then(task); serial = pending.catch(() => undefined); return pending;
  }, ensureReviewSession: async () => ({ listDue: async () => ({ items: [], nextCursor: null }) }) };
  const files = new Map([
    ["Books/fixture.pdf", { path: "Books/fixture.pdf", extension: "pdf" }],
    ["Notes/A.md", { path: "Notes/A.md", extension: "md" }],
  ]);
  const texts = new Map([["Notes/A.md", "Before exact excerpt after"]]);
  const route = { documentId: "document-test", docKey: "012345abcdef", sourcePath: "Books/fixture.pdf",
    source: { sourceHash: "xxh64-v1:0123456789abcdef", orderedPageIdentities: ["page-test"] } };
  const row = { uuid: "highlight-test", kind: "Highlight", pageIndex: 0, deleted: false,
    payload: { editor: { annotationType: 9, text: "exact excerpt" } },
    version: { rev: 1, deviceId: "host-test", seq: 1 } };
  const view = { documentId: "reader-test", openRequest: 1, rendererGeneration: "generation-test",
    annotationHydrationAllowed: true, annotationSourceHash: route.source.sourceHash,
    annotationDocument: route, annotationPageIdentity: { orderedPageIdentities: ["page-test"] },
    documentFile: files.get(route.sourcePath), annotationSnapshot: { annotations: [row] },
    isCurrentReaderAnchorIdentity: identity => identity.documentId === "reader-test" && identity.openRequest === 1 &&
      identity.rendererGeneration === "generation-test" };
  const opened = [], sourceOpenings = [], sourceContexts = [];
  let runtimeLoads = 0, readonlySnapshotReads = 0;
  const plugin = { views: new Set([view]), app: { vault: {
    adapter, getAbstractFileByPath: path => files.get(path), read: async file => texts.get(file.path),
    modifyBinary: () => { throw Error("source PDF writes forbidden"); },
  }, workspace: { getLeavesOfType: () => [] } },
  getVocabularyRuntime: async () => { runtimeLoads++; return runtime; },
  annotationHost: { store: {
    documentForIdentity: async anchor => anchor.documentId === route.documentId && anchor.docKey === route.docKey ? route : null,
    readDocument: async (document, options) => { assert.equal(options.readOnly, true); readonlySnapshotReads++; return view.annotationSnapshot; },
  } },
  readerAnchorStore: { get: async () => null },
  openPdf: async (file, target) => opened.push({ file: file.path, target }),
  openReaderBacklinkSource: async (row, options) => { sourceOpenings.push({ row, options }); return true; },
  openVocabularyContext: async id => { sourceContexts.push(id); return { status: "opening" }; },
  };
  const host = createLearningHost({ plugin, Modal });
  const request = { documentId: view.documentId, openRequest: view.openRequest, rendererGeneration: view.rendererGeneration,
    uuid: row.uuid, pageIndex: 0, pageIdentity: "page-test", sourceHash: route.source.sourceHash,
    revision: 4, confirmedRevision: 4, dirty: false, pending: false,
    targetText: "untrusted replacement text", targetTextSource: "stored" };
  return { adapter, runtime, contexts, files, texts, route, row, view, opened, sourceOpenings, sourceContexts, plugin, host, request,
    runtimeLoads: () => runtimeLoads, readonlySnapshotReads: () => readonlySnapshotReads };
}

test("learning Host is lazy, authenticates the Reader and confirms a durable Highlight draft", async () => {
  const f = fixture();
  assert.equal(f.runtimeLoads(), 0);
  assert.equal(f.adapter.files.size, 0);
  await assert.rejects(f.host.fromAnnotationRequest(f.view, { ...f.request, documentId: "stale" }), /reader-session/);
  const modal = await f.host.fromAnnotationRequest(f.view, f.request);
  assert.equal(modal.answerInput.value, "exact excerpt", "stored targetText wins over the message suggestion");
  assert.equal(f.adapter.files.size, 0, "opening/editing a draft is not confirmation");
  modal.promptInput.value = "What is this excerpt?";
  const result = await modal.confirm();
  assert.equal(result.status, "committed");
  assert.equal(result.item.source.target.id, f.row.uuid);
  assert.equal(result.item.answer, "exact excerpt");
  assert.equal((await (await f.host.getService()).getItem(result.item.itemId)).externalId, result.item.externalId);
  assert.ok([...f.adapter.files.keys()].every(path => !path.endsWith(".pdf") && !path.startsWith("00_Archive/20_PDFData")));
  const before = f.adapter.files.size;
  const second = await f.host.fromAnnotationRequest(f.view, f.request);
  second.cancel();
  assert.equal(f.adapter.files.size, before, "cancelled drafts have no canonical effects");
});

test("a Highlight draft requires exact clean durable revision evidence from the Viewer", async () => {
  const invalidEvidence = [
    { revision: undefined }, { revision: -1 }, { confirmedRevision: undefined },
    { revision: 5 }, { dirty: true }, { dirty: undefined }, { pending: true }, { pending: undefined },
  ];
  for (const evidence of invalidEvidence) {
    const f = fixture();
    await assert.rejects(f.host.fromAnnotationRequest(f.view, { ...f.request, ...evidence }),
      error => error.code === "TARGET_UNRESOLVED" && /save-highlight-before-review/.test(error.message));
    assert.equal(f.runtimeLoads(), 0, "unconfirmed Viewer state must not create a learning runtime or draft");
    assert.equal(f.adapter.files.size, 0);
  }
});

test("workbench review pagination is bounded, reversible and invalidated after a rating", async () => {
  const f = fixture();
  const dueAt = "2026-10-22T00:00:00.000Z";
  let calls = 0;
  let ratings = 0;
  let rows = ["a", "b", "c", "d", "e"].map(familyKey => ({ familyKey, dueAt,
    family: { records: [{ surface: familyKey }] }, state: { box: 1, dueAt } }));
  f.runtime.ensureReviewSession = async () => ({
    listDue: async ({ limit, cursor }) => {
      calls++;
      assert.ok(limit <= 100);
      const start = Number(cursor || 0);
      return { items: rows.slice(start, start + limit), nextCursor: start + limit < rows.length ? String(start + limit) : null };
    },
    remember: async (id, { actionId }) => {
      assert.equal(id, "a"); assert.equal(actionId, "rating-one"); ratings++;
      rows = rows.filter(row => row.familyKey !== id);
      return { status: "reviewed" };
    },
  });
  const pager = await f.host.createWorkbenchReviewPager();
  const first = await pager.listDue({ limit: 2 });
  assert.deepEqual(Array.from(first.items, row => row.familyKey), ["a", "b"]);
  assert.ok(first.items.every(row => row.providerId === "vocabulary" && row.itemId === row.familyKey));
  const beforeForged = calls;
  const forged = first.nextCursor.replace(/:\d+$/, ":99999");
  await assert.rejects(pager.listDue({ limit: 2, cursor: forged }), /cursor/i);
  assert.equal(calls, beforeForged, "a forged deep cursor must not replay thousands of provider pages");
  const second = await pager.listDue({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(Array.from(second.items, row => row.familyKey), ["c", "d"]);
  const third = await pager.listDue({ limit: 2, cursor: second.nextCursor });
  assert.deepEqual(Array.from(third.items, row => row.familyKey), ["e"]);
  assert.equal(third.nextCursor, null);
  const beforeBack = calls;
  const back = await pager.listDue({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(Array.from(back.items, row => row.familyKey), ["c", "d"]);
  assert.ok(calls > beforeBack, "backward navigation reads providers again, not a retained full queue");
  await pager.rate({ providerId: "vocabulary", itemId: "a", kind: "remember", actionId: "rating-one" });
  assert.equal(ratings, 1);
  await assert.rejects(pager.listDue({ limit: 2, cursor: first.nextCursor }), /cursor/i);
  const after = await pager.listDue({ limit: 2 });
  assert.deepEqual(Array.from(after.items, row => row.familyKey), ["b", "c"]);
  await assert.rejects(pager.listDue({ limit: 101 }), /100/);
  await assert.rejects(pager.listDue({ limit: 2, cursor: "not-a-cursor" }), /cursor/i);
});

test("annotation changes invalidate draft confirmation without deleting text or persisted items", async () => {
  const f = fixture();
  const modal = await f.host.fromAnnotationRequest(f.view, f.request);
  modal.promptInput.value = "Question retained";
  f.row.payload.editor.text = "changed source";
  await assert.rejects(modal.confirm(), error => error.code === "LEARNING_SOURCE_STALE");
  assert.equal(modal.closed, false);
  assert.equal(modal.promptInput.value, "Question retained");
  assert.equal(modal.answerInput.value, "exact excerpt");
  assert.equal(f.adapter.files.size, 0);
});

test("Context confirmation rechecks the current source after asynchronous Anchor lookup", {timeout:5000}, async () => {
  const f=fixture();
  const anchor={anchorId:'context-anchor',docKey:f.route.docKey,documentId:f.route.documentId,
    sourceHash:f.route.source.sourceHash,pageIndexHint:0,pageIdentity:'page-test',exactQuote:'exact excerpt'};
  const context={contextId:'context-source',familyKey:'family',anchorId:anchor.anchorId,
    docKey:anchor.docKey,documentId:anchor.documentId,sourceFingerprint:anchor.sourceHash,
    pageIdentity:anchor.pageIdentity,anchor};
  f.contexts.set(context.contextId,context);
  let resume,entered;
  const held=new Promise(resolve=>{resume=resolve;});
  const reached=new Promise(resolve=>{entered=resolve;});
  f.plugin.readerAnchorStore.get=async()=>{entered();await held;return anchor;};
  const modal=await f.host.fromContextId(context.contextId);
  modal.promptInput.value='Context question';
  const confirming=modal.confirm();
  await reached;
  f.view.annotationHydrationAllowed=false;
  f.view.annotationSourceMismatch=true;
  resume();
  await assert.rejects(confirming,error=>error.code==='LEARNING_SOURCE_STALE');
  assert.equal(modal.closed,false);
  assert.equal(modal.promptInput.value,'Context question');
  assert.equal(f.adapter.files.size,0,'a revoked source must not commit any learning item or History');
});

test("mixed Review rows preserve canonical learning state and source fields", async () => {
  const f = fixture();
  const modal = await f.host.fromAnnotationRequest(f.view, f.request);
  modal.promptInput.value = 'Question';
  const saved = await modal.confirm();
  f.runtime.ensureReviewSession = async () => ({ listDue: async () => ({ items: [{
    familyKey:'vocab-one', dueAt:'2000-01-01T00:00:00.000Z',
    family:{records:[{surface:'word'}]},state:{box:1,dueAt:'2000-01-01T00:00:00.000Z'},
  }], nextCursor:null }) });
  const pager = await f.host.createWorkbenchReviewPager();
  const page = await pager.listDue({limit:10});
  assert.deepEqual(Array.from(page.items,row=>row.providerId),['vocabulary','learning']);
  const row = page.items.find(row=>row.providerId==='learning');
  assert.equal(row.itemId,saved.item.itemId);
  assert.equal(row.prompt,saved.item.prompt);
  assert.equal(row.answer,saved.item.answer);
  assert.deepEqual(row.reviewState,saved.item.reviewState);
  assert.deepEqual(row.source,saved.item.source);
  assert.equal(page.nextCursor,null);
});

test("Source reuses exact UUID navigation, rejects deletion and keeps the learning item", async () => {
  const f = fixture();
  const modal = await f.host.fromAnnotationRequest(f.view, f.request);
  modal.promptInput.value = "Question";
  const saved = await modal.confirm();
  f.plugin.views.clear();
  assert.equal((await f.host.openItemSource(saved.item.itemId)).status, "opening");
  assert.equal(f.readonlySnapshotReads(), 0, "Source navigation must not replay the whole Sidecar before normal Reader open");
  assert.equal(f.opened[0].target.id, f.row.uuid);
  assert.equal(f.opened[0].target.documentId, f.route.documentId);
  // Normal Reader open owns source validation/replay and publishes this view;
  // the fake Workspace boundary above only records the opening request.
  f.plugin.views.add(f.view);
  f.view.annotationSnapshot = { annotations: [], tombstones: [{ uuid: f.row.uuid }] };
  await assert.rejects(f.host.openItemSource(saved.item.itemId), error => error.code === "TARGET_UNRESOLVED");
  assert.equal(f.opened.length, 1, "deleted targets must not be rebound or opened by old coordinates");
  assert.ok(await (await f.host.getService()).getItem(saved.item.itemId));
});

test("Markdown draft, rename and Source preserve exact range without a second navigation implementation", async () => {
  const f = fixture();
  const text = f.texts.get("Notes/A.md"), start = text.indexOf("exact excerpt"), end = start + "exact excerpt".length;
  const editor = { getCursor: side => ({ line: 0, ch: side === "from" ? start : end }),
    posToOffset: pos => pos.ch, getSelection: () => "exact excerpt" };
  const modal = await f.host.fromMarkdownEditor(editor, { file: f.files.get("Notes/A.md") });
  modal.promptInput.value = "Markdown question";
  const saved = await modal.confirm();
  assert.equal(saved.item.source.documentId, null);
  f.files.delete("Notes/A.md"); f.files.set("Archive/B.md", { path: "Archive/B.md", extension: "md" });
  f.texts.set("Archive/B.md", text);
  await f.host.renamed("Notes/A.md", "Archive/B.md");
  assert.equal((await f.host.openItemSource(saved.item.itemId)).status,'opening');
  const opened = f.sourceOpenings[0];
  assert.equal(opened.row.sourcePath, "Archive/B.md");
  assert.equal(opened.row.offset, start);
  assert.equal(opened.row.endOffset, end);
  assert.equal(opened.row.sourceText, "exact excerpt");
  assert.equal(opened.options.requireExact,true,'learning excerpts must not silently use line/file fallback');
  f.plugin.openReaderBacklinkSource = async () => false;
  await assert.rejects(f.host.openItemSource(saved.item.itemId),error=>error.code==='TARGET_UNRESOLVED');
  assert.ok(await (await f.host.getService()).getItem(saved.item.itemId));
  f.texts.set("Archive/B.md", "This source changed");
  await assert.rejects(f.host.openItemSource(saved.item.itemId), error => error.code === "TARGET_UNRESOLVED");
  assert.equal(f.sourceOpenings.length, 1);
});

test("Vocabulary Source uses one Context directly and the existing Context tab for multiple sources", async () => {
  const f = fixture();
  assert.equal((await f.host.openVocabularySource("family")).status, "missing");
  f.contexts.set("context-one", { contextId: "context-one", familyKey: "family" });
  await f.host.openVocabularySource("family");
  assert.deepEqual(f.sourceContexts, ["context-one"]);
  f.contexts.set("context-two", { contextId: "context-two", familyKey: "family" });
  assert.equal((await f.host.openVocabularySource("family")).status, "choose-context");
  assert.equal(f.sourceContexts.length, 1);
});

test("empty rename and Host disposal do not initialize a new database or leave a draft alive", async () => {
  const f = fixture();
  assert.equal((await f.host.renamed("Notes", "Archive")).status, "noop");
  assert.equal(f.runtimeLoads(), 0);
  const modal = await f.host.fromAnnotationRequest(f.view, f.request);
  f.host.dispose();
  assert.equal(modal.closed, true);
  assert.equal(f.adapter.files.size, 0);
  await assert.rejects(f.host.fromAnnotationRequest(f.view, f.request), /workspace-closed/);
});
