import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  fromAnnotation,
  fromReaderAnchor,
  fromContext,
  fromBacklink,
  fromMarkdown,
  matchesMarkdownSourceSlice,
  createSemanticSourceResolver,
} = require("../plugin/semantic/semantic-anchor.cjs");

const sourceHash = `sha256-v1:${"a".repeat(64)}`;
const identity = {
  documentId: "document-1",
  docKey: "012345abcdef",
  sourcePath: "Books/Reader.pdf",
  sourceHash,
  pageIdentity: "page-identity-2",
};

function verified(anchor, overrides = {}) {
  return { status: "verified", sourceCurrent: true, pageCurrent: true, anchor, ...overrides };
}

test("SemanticAnchor factories adapt existing annotation, Reader Anchor, Context, backlink and Markdown rows", () => {
  const annotation = fromAnnotation({
    uuid: "annotation-1", kind: "Highlight", pageIndex: 1,
    editorPayload: { text: "stored quote" },
  }, identity);
  assert.deepEqual(annotation, {
    target: { kind: "annotation", id: "annotation-1" },
    documentId: identity.documentId,
    docKey: identity.docKey,
    sourcePath: identity.sourcePath,
    sourceHash,
    pageIndex: 1,
    pageIdentity: identity.pageIdentity,
    targetText: "stored quote",
    targetTextSource: "stored",
    evidenceKind: "annotation",
    sourceRange: null,
  });

  const versionedAnnotation = fromAnnotation({ uuid: "annotation-versioned", kind: "Highlight", pageIndex: 1,
    version: { rev: 8, deviceId: "device-a", seq: 3 },
    clock: { timestamp: 1700000000000, logical: 2, deviceId: "device-a", opId: "op-3" },
    editorPayload: { text: "versioned quote" },
  }, identity);
  assert.deepEqual(versionedAnnotation.annotationVersion, {
    version: { rev: 8, deviceId: "device-a", seq: 3 },
    clock: { timestamp: 1700000000000, logical: 2, deviceId: "device-a", opId: "op-3" },
  }, "existing row revision evidence is retained without minting a new version");

  const readerAnchor = {
    anchorId: "selection-1", documentId: identity.documentId, docKey: identity.docKey,
    sourceHash, pageIdentity: identity.pageIdentity, pageIndexHint: 1, exactQuote: "captured quote",
  };
  assert.equal(fromReaderAnchor(readerAnchor, { sourcePath: identity.sourcePath }).targetTextSource, "captured");

  const context = fromContext({ id: "context-1", readerAnchor }, { sourcePath: identity.sourcePath });
  assert.equal(context.target.kind, "selection", "Context keeps the existing Reader target");
  assert.equal(context.target.id, "selection-1");
  assert.equal(context.evidenceKind, "context");
  assert.equal(context.contextId, "context-1");

  const backlink = fromBacklink({
    sourcePath: "Notes/Chapter.md", target: { kind: "annotation", id: "annotation-1" },
    docKey: identity.docKey, documentId: identity.documentId, offset: 20, endOffset: 64,
    line: 3, displayText: "not an exact source slice",
  }, { pageIndex: 1, pageIdentity: identity.pageIdentity, sourceText: "[[Reader.pdf#obreader=ann.annotation-1|note]]" });
  assert.deepEqual(backlink.target, { kind: "annotation", id: "annotation-1" });
  assert.equal(backlink.sourcePath, "Notes/Chapter.md");
  assert.deepEqual(backlink.sourceRange, {
    startOffset: 20, endOffset: 64, line: 3,
    text: "[[Reader.pdf#obreader=ann.annotation-1|note]]",
  });
  assert.equal(backlink.targetText, "", "backlink display text is not promoted to target quote evidence");
  assert.equal(backlink.targetTextSource, "unavailable");

  const markdown = fromMarkdown({ sourcePath: "Notes/Chapter.md", offset: 7, endOffset: 20, line: 0,
    text: "exact excerpt" });
  assert.equal(markdown.target.kind, "markdown");
  assert.equal(markdown.sourcePath, "Notes/Chapter.md");
  assert.deepEqual(markdown.sourceRange, {
    startOffset: 7, endOffset: 20, line: 0, text: "exact excerpt",
  });
  assert.equal(markdown.targetText, "exact excerpt");
  assert.equal(markdown.targetTextSource, "captured");
  assert.equal(matchesMarkdownSourceSlice(markdown, "prefix exact excerpt suffix"), true);
  assert.equal(matchesMarkdownSourceSlice(markdown, "prefix similar excerpt suffix"), false,
    "changed excerpts do not fuzzy-rebind to nearby text");
});

test("resolveSource verifies exact existing evidence and returns only a separate non-exact page fallback", async () => {
  const anchor = fromAnnotation({ uuid: "annotation-live", kind: "Highlight", pageIndex: 1,
    editorPayload: { text: "quote" } }, identity);
  const resolver = createSemanticSourceResolver({
    verifyRouting: async value => verified(value),
    verifyAnnotation: async value => verified(value),
  });
  const result = await resolver(anchor);
  assert.equal(result.status, "verified");
  assert.equal(result.sourceCurrent, true);
  assert.equal(result.pageCurrent, true);
  assert.deepEqual(result.anchor, anchor);

  const sourceMismatch = createSemanticSourceResolver({
    verifyRouting: async value => ({ status: "invalid", sourceCurrent: false, pageCurrent: false,
      anchor: value, code: "SOURCE_HASH_MISMATCH" }),
    verifyAnnotation: async value => verified(value),
  });
  const staleSource = await sourceMismatch(anchor);
  assert.equal(staleSource.code, "TARGET_UNRESOLVED");
  assert.equal(staleSource.pageFallback, null, "a mismatched source cannot lend its page identity as a fallback");

  const deleted = createSemanticSourceResolver({
    verifyRouting: async value => verified(value),
    verifyAnnotation: async value => ({ status: "invalid", sourceCurrent: true, pageCurrent: true,
      anchor: value, code: "ANNOTATION_DELETED" }),
  });
  const unresolved = await deleted(anchor);
  assert.equal(unresolved.code, "TARGET_UNRESOLVED");
  assert.equal(unresolved.exact, false);
  assert.deepEqual(unresolved.pageFallback, {
    kind: "page", id: identity.pageIdentity, pageIndex: 1, exact: false,
  });

  const rebound = createSemanticSourceResolver({
    verifyRouting: async value => verified(value),
    verifyAnnotation: async value => verified({ ...value, target: { kind: "annotation", id: "different" } }),
  });
  assert.equal((await rebound(anchor)).code, "TARGET_UNRESOLVED",
    "a verifier cannot silently replace a target with a similar one");
});

test("resolveSource requires an exact Markdown source slice and the verifier must echo its input", async () => {
  const markdown = fromMarkdown({ sourcePath: "Notes/Quote.md", offset: 5, endOffset: 17, line: 1,
    text: "quoted words" });
  const resolver = createSemanticSourceResolver({
    verifyMarkdown: async value => matchesMarkdownSourceSlice(value, "xxxx quoted words tail")
      ? verified(value)
      : { status: "invalid", sourceCurrent: false, pageCurrent: false, anchor: value, code: "MARKDOWN_SLICE_CHANGED" },
  });
  assert.equal((await resolver(markdown)).status, "verified");

  const changed = createSemanticSourceResolver({
    verifyMarkdown: async value => matchesMarkdownSourceSlice(value, "xxxx quoted word! tail")
      ? verified(value)
      : { status: "invalid", sourceCurrent: false, pageCurrent: false, anchor: value, code: "MARKDOWN_SLICE_CHANGED" },
  });
  const result = await changed(markdown);
  assert.equal(result.code, "TARGET_UNRESOLVED");
  assert.equal(result.pageFallback, null);

  const wrongEcho = createSemanticSourceResolver({
    verifyMarkdown: async value => verified({ ...value, sourcePath: "Notes/Renamed.md" }),
  });
  assert.equal((await wrongEcho(markdown)).code, "TARGET_UNRESOLVED");
});
