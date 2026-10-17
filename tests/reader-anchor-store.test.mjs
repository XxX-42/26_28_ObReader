import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createReaderAnchorStore, encodeReaderLinkFragment, parseReaderLinkFragment } =
  require("../plugin/reader-anchor-store.cjs");
const { buildReaderBacklinkPageIndex, createReaderBacklinkIndex } =
  require("../plugin/reader-backlink-index.cjs");

class MemoryAdapter {
  files = new Map();
  directories = new Set([""]);
  async exists(path) { return this.files.has(path) || this.directories.has(path); }
  async mkdir(path) { this.directories.add(path); }
  async read(path) { if (!this.files.has(path)) throw new Error("missing"); return this.files.get(path); }
  async write(path, data) { this.files.set(path, data); }
  async rename(from, to) { if (this.files.has(to)) throw new Error("occupied"); this.files.set(to, this.files.get(from)); this.files.delete(from); }
  async list(path) { return { files: [...this.files.keys()].filter((item) => item.startsWith(`${path}/`) && !item.slice(path.length + 1).includes("/")), folders: [] }; }
}

const hash = async (bytes) => `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;
const anchorFixture = {
  docKey: "aabbccddeeff",
  documentId: "xxh64-v1:0123456789abcdef",
  sourceHash: "xxh64-v1:0123456789abcdef",
  pageIdentity: "ref:37R",
  pageIndexHint: 36,
  pageCount: 120,
  orderedPageIdentityDigest: "xxh64-v1:abcdef0123456789",
  textPosition: { start: 14, end: 38 },
  exactQuote: "the exact selected sentence",
  prefix: "a short preceding context ",
  suffix: " and a short following context",
  geometry: { x: 0.1, y: 0.2, width: 0.4, height: 0.03 },
  createdAt: 1792200000000,
};

test("native PDF fragment remains usable while carrying enhanced stable identity", () => {
  const fragment = encodeReaderLinkFragment({
    pageNumber: 42,
    selection: "15,3,18,9",
    docKey: "aabbccddeeff",
    documentId: "xxh64-v1:0123456789abcdef",
    target: { kind: "selection", id: "anchor-abc_123" },
  });
  assert.match(fragment, /page=42/);
  assert.match(fragment, /selection=15%2C3%2C18%2C9/);
  const parsed = parseReaderLinkFragment(fragment);
  assert.deepEqual(parsed, {
    pageNumber: 42,
    selection: "15,3,18,9",
    docKey: "aabbccddeeff",
    documentId: "xxh64-v1:0123456789abcdef",
    target: { kind: "selection", id: "anchor-abc_123" },
  });
  const page = parseReaderLinkFragment(encodeReaderLinkFragment({
    pageNumber: 37, target: { kind: "page", id: "ref:37R" },
  }));
  assert.deepEqual(page.target, { kind: "page", id: "ref:37R" });
});

test("Selection Anchors use a dedicated immutable Vault namespace with verified integrity", async () => {
  const adapter = new MemoryAdapter();
  let sequence = 0;
  const store = createReaderAnchorStore({ adapter, hash, makeId: () => `anchor-${++sequence}` });
  const created = await store.create(anchorFixture);
  assert.equal(created.anchorId, "anchor-1");
  assert.deepEqual([...adapter.files.keys()], ["00_Archive/20_PDFData/anchors/aabbccddeeff/anchor-1.json"]);
  assert.ok(![...adapter.files.keys()].some((path) => path.includes("/sidecars/") || path.includes("/wal/")));
  assert.equal((await store.get(anchorFixture.docKey, created.anchorId, anchorFixture.documentId)).exactQuote,
    anchorFixture.exactQuote);
  assert.deepEqual((await store.list(anchorFixture.docKey)).errors, []);
});

test("Anchor Store fails closed on corruption and document identity mismatch", async () => {
  const adapter = new MemoryAdapter();
  const store = createReaderAnchorStore({ adapter, hash, makeId: () => "anchor-identity" });
  const created = await store.create(anchorFixture);
  await assert.rejects(store.get(anchorFixture.docKey, created.anchorId, "other-document"),
    (error) => error.code === "READER_ANCHOR_IDENTITY_MISMATCH");
  const path = store.pathFor(anchorFixture.docKey, created.anchorId);
  const corrupted = JSON.parse(adapter.files.get(path));
  corrupted.exactQuote = "tampered";
  adapter.files.set(path, JSON.stringify(corrupted));
  await assert.rejects(store.get(anchorFixture.docKey, created.anchorId),
    (error) => error.code === "WAL_INTEGRITY_MISMATCH");
});

test("Anchor Store recreates deleted directories and rejects malformed source evidence", async () => {
  const adapter = new MemoryAdapter();
  let sequence = 0;
  const store = createReaderAnchorStore({ adapter, hash, makeId: () => `anchor-dir-${++sequence}` });
  const first = await store.create(anchorFixture);
  adapter.directories.delete(store.directoryFor(anchorFixture.docKey));
  const second = await store.create({ ...anchorFixture, anchorId: "anchor-dir-second" });
  assert.ok(adapter.directories.has(store.directoryFor(anchorFixture.docKey)));
  assert.equal((await store.get(anchorFixture.docKey, first.anchorId)).anchorId, first.anchorId);
  assert.equal((await store.get(anchorFixture.docKey, second.anchorId)).anchorId, second.anchorId);
  await assert.rejects(store.create({ ...anchorFixture, anchorId: "anchor-bad-hash", sourceHash: "xxh64-v1:short" }),
    (error) => error.code === "READER_ANCHOR_INVALID");
});

test("backlink index updates only the changed Markdown file and can be rebuilt", () => {
  const index = createReaderBacklinkIndex();
  const first = { path: "Notes/Quote.md" };
  const second = { path: "Notes/Annotation.md" };
  const link = (obreader, offset) => ({ link: `Book.pdf#page=42&docKey=aabbccddeeff&obreader=${obreader}`,
    displayText: "quoted text", position: { start: { offset, line: 2 } } });
  index.replaceFile(first, { links: [link("sel.anchor-1", 10)] });
  index.replaceFile(second, { links: [link("ann.550e8400-e29b-41d4-a716-446655440000", 20)] });
  assert.equal(index.get("aabbccddeeff", { kind: "selection", id: "anchor-1" }).length, 1);
  assert.equal(index.getDocument("aabbccddeeff").length, 2);
  index.replaceFile(first, { links: [link("sel.anchor-2", 11)] });
  assert.equal(index.get("aabbccddeeff", { kind: "selection", id: "anchor-1" }).length, 0);
  assert.equal(index.get("aabbccddeeff", { kind: "selection", id: "anchor-2" })[0].sourcePath, first.path);
  index.removeFile(second.path);
  assert.equal(index.getDocument("aabbccddeeff").length, 1);
});

test("backlink index isolates matching short keys by full document identity", () => {
  const index = createReaderBacklinkIndex();
  const target = "ann.550e8400-e29b-41d4-a716-446655440000";
  const row = (documentId, sourcePath) => [
    { path: sourcePath },
    { links: [{
      link: `Book.pdf#page=2&docKey=aabbccddeeff&obdoc=${encodeURIComponent(documentId)}&obreader=${target}`,
      displayText: "annotation", position: { start: { offset: 4, line: 1 } },
    }] },
  ];
  const [fileA, cacheA] = row("document-a", "Notes/A.md");
  const [fileB, cacheB] = row("document-b", "Notes/B.md");
  index.replaceFile(fileA, cacheA);
  index.replaceFile(fileB, cacheB);
  assert.equal(index.get("aabbccddeeff", { kind: "annotation", id: target.slice(4) }, "document-a").length, 1);
  assert.equal(index.getDocument("aabbccddeeff", "document-a")[0].sourcePath, "Notes/A.md");
  assert.equal(index.getDocument("aabbccddeeff", "document-b")[0].sourcePath, "Notes/B.md");
});

test("backlink page index resolves each referenced Anchor once and groups page, selection, and annotation links", async () => {
  const index = createReaderBacklinkIndex();
  const docKey = "aabbccddeeff";
  const documentId = "document-full-id";
  const pageIdentities = ["page-one", "page-two"];
  const annotationId = "550e8400-e29b-41d4-a716-446655440000";
  const deletedId = "550e8400-e29b-41d4-a716-446655440001";
  const makeLink = (target, file, offset, page = 1) => [
    { path: file },
    { links: [{
      link: `Book.pdf#page=${page}&docKey=${docKey}&obdoc=${encodeURIComponent(documentId)}&obreader=${target}`,
      displayText: `reference ${offset}`,
      position: { start: { offset, line: 2 } },
    }] },
  ];
  for (const [target, file, offset] of [
    ["page.page-one", "Notes/Page.md", 1],
    ["sel.anchor-linked", "Notes/SelectionA.md", 2],
    ["sel.anchor-linked", "Notes/SelectionB.md", 3],
    [`ann.${annotationId}`, "Notes/Annotation.md", 4],
    [`ann.${deletedId}`, "Notes/Deleted.md", 5],
  ]) {
    const [sourceFile, cache] = makeLink(target, file, offset);
    index.replaceFile(sourceFile, cache);
  }
  const anchor = {
    ...anchorFixture,
    docKey,
    documentId,
    anchorId: "anchor-linked",
    pageIdentity: "page-one",
    textPosition: { start: 15, end: 24 },
  };
  let anchorReads = 0;
  const pageIndex = await buildReaderBacklinkPageIndex({
    index,
    anchorStore: {
      async get(requestedDocKey, anchorId, requestedDocumentId) {
        anchorReads += 1;
        assert.equal(requestedDocKey, docKey);
        assert.equal(requestedDocumentId, documentId);
        assert.equal(anchorId, "anchor-linked");
        return anchor;
      },
      async list() { throw new Error("page index must not enumerate unlinked anchors"); },
    },
    docKey,
    documentId,
    pageIdentities,
    annotations: [{ uuid: annotationId, pageIndex: 0, deleted: false }],
    tombstones: [{ uuid: deletedId, pageIndex: 0, deleted: true }],
  });

  assert.equal(anchorReads, 1, "duplicate Markdown references resolve one immutable Anchor once");
  const page = pageIndex.forPage("page-one");
  assert.equal(page.rows.length, 5);
  assert.deepEqual(new Set(page.markers.map((marker) => marker.kind)), new Set(["page", "selection", "annotation"]));
  assert.equal(page.markers.find((marker) => marker.kind === "selection").backlinkCount, 2);
  assert.equal(page.rows.find((row) => row.target.id === deletedId).targetStatus, "deleted");
  assert.equal(pageIndex.forPage("page-two").rows.length, 0);
  assert.deepEqual(pageIndex.forOccurrence("page-one", 15, 24).anchorIds, ["anchor-linked"]);
  assert.equal(pageIndex.forOccurrence("page-one", 15, 24).rows.length, 2);
  assert.equal(pageIndex.forAnchorIds(["anchor-linked", "missing"]).length, 2);
});

test("backlink page index fails closed on invalid linked anchors without enumerating the store", async () => {
  const index = createReaderBacklinkIndex();
  const sourceFile = { path: "Notes/Broken.md" };
  index.replaceFile(sourceFile, { links: [{
    link: "Book.pdf#page=1&docKey=aabbccddeeff&obdoc=document-full-id&obreader=sel.anchor-broken",
    position: { start: { offset: 1, line: 0 } },
  }] });
  const errors = [];
  const pageIndex = await buildReaderBacklinkPageIndex({
    index,
    anchorStore: { async get() { const error = new Error("bad integrity"); error.code = "WAL_INTEGRITY_MISMATCH"; throw error; } },
    docKey: "aabbccddeeff",
    documentId: "document-full-id",
    pageIdentities: ["page-one"],
    onInvalidAnchor: (error, anchorId) => errors.push([error.code, anchorId]),
  });
  assert.deepEqual(errors, [["WAL_INTEGRITY_MISMATCH", "anchor-broken"]]);
  assert.equal(pageIndex.forPage("page-one").rows.length, 0);
});
