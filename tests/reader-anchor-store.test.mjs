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
  async list(path) {
    const prefix = path ? `${path}/` : "";
    const children = [...this.directories].filter(item => item.startsWith(prefix) && item !== path)
      .map(item => item.slice(prefix.length)).filter(item => item && !item.includes("/"));
    return { files: [...this.files.keys()].filter((item) => item.startsWith(prefix) && !item.slice(prefix.length).includes("/")),
      folders: [...new Set(children)] };
  }
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

test("copied Reader fragments hide validated internal identity and retain native fallbacks with a stable target", () => {
  const fragment = encodeReaderLinkFragment({
    pageNumber: 42,
    selection: "15,3,18,9",
    docKey: "aabbccddeeff",
    documentId: "xxh64-v1:0123456789abcdef",
    target: { kind: "selection", id: "anchor-abc_123" },
  });
  assert.equal(fragment,
    "page=42&selection=15%2C3%2C18%2C9&obreader=sel.anchor-abc_123");
  assert.doesNotMatch(fragment, /(?:docKey|obdoc)=/u,
    "new Reader links must not expose internal document routing identifiers");
  const parsed = parseReaderLinkFragment(fragment);
  assert.deepEqual(parsed, {
    pageNumber: 42,
    selection: "15,3,18,9",
    docKey: null,
    documentId: null,
    target: { kind: "selection", id: "anchor-abc_123" },
  });
  assert.deepEqual(parseReaderLinkFragment("page=42&obreader=sel.anchor-abc_123"), {
    pageNumber: 42, selection: null, docKey: null, documentId: null,
    target: { kind: "selection", id: "anchor-abc_123" },
  }, "the previously emitted compact path-only fragment remains readable");
  assert.throws(() => encodeReaderLinkFragment({ pageNumber: 42, docKey: "short",
    documentId: "xxh64-v1:0123456789abcdef", target: { kind: "selection", id: "anchor-abc_123" } }),
  (error) => error.code === "READER_LINK_IDENTITY_INVALID",
  "a malformed identity cannot silently downgrade into a path-only link");
  assert.throws(() => encodeReaderLinkFragment({ pageNumber: 42, docKey: "aabbccddeeff",
    target: { kind: "selection", id: "anchor-abc_123" } }),
  (error) => error.code === "READER_LINK_IDENTITY_INVALID",
  "internal identity validation still requires docKey and obdoc as a pair");
  assert.throws(() => encodeReaderLinkFragment({ pageNumber: 42, docKey: "aabbccddeeff",
    documentId: "x".repeat(513), target: { kind: "selection", id: "anchor-abc_123" } }),
  (error) => error.code === "READER_LINK_IDENTITY_INVALID",
  "identity values over the existing parser limit cannot be emitted");
  const legacy = parseReaderLinkFragment(
    "page=42&selection=15%2C3%2C18%2C9&docKey=aabbccddeeff&obdoc=xxh64-v1%3A0123456789abcdef&obreader=sel.anchor-abc_123",
  );
  assert.deepEqual(legacy, {
    pageNumber: 42, selection: "15,3,18,9", docKey: "aabbccddeeff",
    documentId: "xxh64-v1:0123456789abcdef",
    target: { kind: "selection", id: "anchor-abc_123" },
  }, "previously copied identity-bearing links remain readable");
  const page = parseReaderLinkFragment(encodeReaderLinkFragment({
    pageNumber: 37, target: { kind: "page", id: "ref:37R" },
  }));
  assert.deepEqual(page.target, { kind: "page", id: "ref:37R" });
  assert.equal(parseReaderLinkFragment("page=1&obreader=sel.x").target, null,
    "selection targets must satisfy the Anchor ID grammar before entering backlink indexing");
  assert.deepEqual(parseReaderLinkFragment("page=1&obreader=ann.x").target,
    { kind: "annotation", id: "x" },
    "existing annotation identifiers retain their broader historical grammar");
  assert.deepEqual(parseReaderLinkFragment("page=1&obreader=ann.custom%3Aid.v1").target,
    { kind: "annotation", id: "custom:id.v1" },
    "safe punctuation in existing Annotation IDs remains readable");
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

test("compact Selection Anchor links resolve their document identity after the PDF path moves", async () => {
  const adapter = new MemoryAdapter();
  const store = createReaderAnchorStore({ adapter, hash, makeId: () => "anchor-route-1" });
  const created = await store.create(anchorFixture);
  const restartedStore = createReaderAnchorStore({ adapter, hash, makeId: () => "unused-anchor-id" });
  const resolved = await restartedStore.findById(created.anchorId);
  assert.equal(resolved.anchorId, created.anchorId);
  assert.equal(resolved.docKey, created.docKey);
  assert.equal(resolved.documentId, created.documentId);
  assert.equal(resolved.sourceHash, created.sourceHash);
  assert.equal(resolved.exactQuote, created.exactQuote);
  const batch = await restartedStore.findManyById([created.anchorId, "anchor-not-present"]);
  assert.equal(batch.anchors.get(created.anchorId).documentId, created.documentId);
  assert.equal(batch.anchors.has("anchor-not-present"), false);
  const mixedValidity = await restartedStore.findManyById([created.anchorId, "x"]);
  assert.equal(mixedValidity.anchors.get(created.anchorId).documentId, created.documentId,
    "one malformed ID must not prevent valid IDs in the same batch from resolving");
  assert.equal(mixedValidity.errors.get("x").code, "READER_ANCHOR_ID_INVALID");

  const originalList = adapter.list.bind(adapter);
  adapter.list = async (directory) => {
    const listing = await originalList(directory);
    return directory === restartedStore.root
      ? { ...listing, folders: listing.folders.map((folder) => `${folder}/`) }
      : listing;
  };
  const trailingSlashBatch = await restartedStore.findManyById([created.anchorId]);
  assert.equal(trailingSlashBatch.anchors.get(created.anchorId).documentId, created.documentId,
    "folder listings with trailing slashes must still resolve document directories");

  const duplicate = await store.create({ ...anchorFixture, docKey: "ffeeddccbbaa", documentId: "xxh64-v1:fedcba9876543210" });
  assert.equal(duplicate.anchorId, created.anchorId);
  await assert.rejects(restartedStore.findById(created.anchorId),
    error => error.code === "READER_ANCHOR_ID_AMBIGUOUS",
    "copied or colliding Anchor IDs fail closed rather than selecting an arbitrary document");
  const ambiguousBatch = await restartedStore.findManyById([created.anchorId]);
  assert.equal(ambiguousBatch.anchors.has(created.anchorId), false);
  assert.equal(ambiguousBatch.errors.get(created.anchorId).code, "READER_ANCHOR_ID_AMBIGUOUS");
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

test("backlink index exposes a read-only exact folder-prefix source set", () => {
  const index = createReaderBacklinkIndex();
  const link = { link: "Books/Book.pdf#page=1&obreader=page.page-one",
    position: { start: { offset: 0, line: 0 } } };
  for (const sourcePath of ["Notes/Nested/One.md", "Notes/Two.md", "Notes-old/Three.md"]) {
    index.replaceFile({ path: sourcePath }, { links: [link] });
  }
  assert.deepEqual(index.getSourcePathsUnder("Notes"), ["Notes/Nested/One.md", "Notes/Two.md"]);
  assert.deepEqual(index.getSourcePathsUnder("Notes/"), ["Notes/Nested/One.md", "Notes/Two.md"]);
  assert.deepEqual(index.getSourcePathsUnder("Notes-old"), ["Notes-old/Three.md"]);
});

test("backlink index preserves MetadataCache link end offsets for exact source focus", () => {
  const index = createReaderBacklinkIndex();
  const sourcePath = "Notes/Exact Source.md";
  index.replaceFile({ path: sourcePath }, { links: [{
    link: "Book.pdf#page=2&docKey=aabbccddeeff&obreader=page.page-two",
    original: "[[Book.pdf#page=2&docKey=aabbccddeeff&obreader=page.page-two|page reference]]",
    displayText: "page reference",
    position: { start: { offset: 17, line: 1 }, end: { offset: 42, line: 1 } },
  }] });
  const [row] = index.get("aabbccddeeff", { kind: "page", id: "page-two" });
  assert.equal(row.offset, 17);
  assert.equal(row.endOffset, 42);
  assert.equal(row.sourceText,
    "[[Book.pdf#page=2&docKey=aabbccddeeff&obreader=page.page-two|page reference]]",
    "the exact original MetadataCache link span is retained for editor-buffer validation");

  index.replaceFile({ path: sourcePath }, { links: [{
    link: "Book.pdf#page=2&docKey=aabbccddeeff&obreader=page.page-two",
    position: { start: { offset: 5, line: 0 } },
  }] });
  assert.equal(index.get("aabbccddeeff", { kind: "page", id: "page-two" })[0].endOffset, null,
    "missing end offsets stay absent instead of being inferred from display text");
  assert.equal(index.get("aabbccddeeff", { kind: "page", id: "page-two" })[0].sourceText, null,
    "missing original syntax stays unavailable instead of being reconstructed from the destination");
});

test("path-only Reader links are indexed by their resolved vault PDF route", async () => {
  const index = createReaderBacklinkIndex();
  const docKey = "aabbccddeeff";
  const documentId = "document-full-id";
  const pageIdentities = ["page-one"];
  const source = { path: "Notes/Quote.md" };
  const fragment = encodeReaderLinkFragment({
    pageNumber: 1, target: { kind: "selection", id: "anchor-path" },
  });
  index.replaceFile(source, { links: [{
    link: `Books/Book%20A.pdf#${fragment}`,
    displayText: "quoted passage",
    position: { start: { offset: 12, line: 3 } },
  }] });

  const routeRows = index.getByPdfPath("Books/Book A.pdf");
  assert.equal(routeRows.length, 1);
  assert.equal(routeRows[0].routePath, "Books/Book A.pdf");
  assert.equal(routeRows[0].docKey, null);
  assert.equal(routeRows[0].documentId, null);

  const anchor = { ...anchorFixture, docKey, documentId, anchorId: "anchor-path", pageIdentity: "page-one" };
  const pageIndex = await buildReaderBacklinkPageIndex({
    index,
    sourcePath: "Books/Book A.pdf",
    anchorStore: { async get(key, id, expectedId) {
      assert.equal(key, docKey);
      assert.equal(id, "anchor-path");
      assert.equal(expectedId, documentId);
      return anchor;
    } },
    docKey, documentId, pageIdentities,
  });
  assert.equal(pageIndex.forPage("page-one").rows.length, 1);
  assert.equal(pageIndex.forPage("page-one").markers[0].kind, "selection");
  index.replaceFile(source, { links: [] });
  assert.equal(index.getByPdfPath("Books/Book A.pdf").length, 0);
});

test("compact Selection backlinks bind by verified Anchor identity after a PDF moves", async () => {
  const index = createReaderBacklinkIndex();
  const docKey = "aabbccddeeff";
  const documentId = "document-full-id";
  const anchorId = "anchor-moved";
  const source = { path: "Notes/Quote.md" };
  const fragment = encodeReaderLinkFragment({ pageNumber: 1,
    target: { kind: "selection", id: anchorId } });
  index.replaceFile(source, { links: [{
    link: `Old/Book.pdf#${fragment}`,
    displayText: "quoted passage",
    position: { start: { offset: 12, line: 3 } },
  }] });
  assert.deepEqual(index.getCompactSelectionAnchorIds(), [anchorId]);
  assert.equal(index.getDocument(docKey, documentId).length, 0);

  const anchor = { ...anchorFixture, docKey, documentId, anchorId, pageIdentity: "page-one" };
  assert.equal(index.bindCompactSelectionAnchor(anchor), true);
  assert.equal(index.bindCompactSelectionAnchor(anchor), false, "binding an existing exact target is idempotent");
  const boundRows = index.getDocument(docKey, documentId);
  assert.equal(boundRows.length, 1);
  assert.equal(boundRows[0].identityResolvedFromAnchor, true);
  assert.equal(boundRows[0].routePath, "Old/Book.pdf");

  const pageIndex = await buildReaderBacklinkPageIndex({
    index,
    sourcePath: "New/Book.pdf",
    anchorStore: { async get(key, id, expectedId) {
      assert.equal(key, docKey);
      assert.equal(id, anchorId);
      assert.equal(expectedId, documentId);
      return anchor;
    } },
    docKey, documentId, pageIdentities: ["page-one"],
  });
  const movedPageRow = pageIndex.forPage("page-one").rows[0];
  assert.equal(pageIndex.forPage("page-one").rows.length, 1);
  assert.equal(movedPageRow.readerDocKey, docKey,
    "the current Reader document identity is attached to in-memory backlink rows after a move");
  assert.equal(movedPageRow.readerDocumentId, documentId,
    "identity enrichment stays in the derived page index and never enters Markdown storage");
  assert.equal(pageIndex.forPage("page-one").markers[0].id, anchorId);

  assert.equal(index.clearCompactSelectionBinding(anchorId), true);
  assert.equal(index.getDocument(docKey, documentId).length, 0);
  assert.equal(index.getByPdfPath("Old/Book.pdf").length, 1,
    "clearing verified identity resolution retains the native path fallback row");
  assert.equal(index.bindCompactSelectionAnchor(anchor), true);
  index.removeFile(source.path);
  assert.equal(index.getDocument(docKey, documentId).length, 0,
    "removing the Markdown source also removes its derived identity binding");
  assert.deepEqual(index.getCompactSelectionAnchorIds(), []);
});

test("explicit relative PDF routes resolve against the Markdown note path", () => {
  const index = createReaderBacklinkIndex();
  index.replaceFile({ path: "Notes/Quotes/Reference.md" }, { links: [{
    link: "../../Books/Book.pdf#page=9&obreader=page.page-identity",
    position: { start: { offset: 0, line: 0 } },
  }] });
  assert.equal(index.getByPdfPath("Books/Book.pdf").length, 1);
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
