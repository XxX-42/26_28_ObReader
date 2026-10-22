import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const semanticModule = process.env.OBREADER_SEMANTIC_MODULE ||
  fileURLToPath(new URL("../plugin/semantic/semantic-anchor.cjs", import.meta.url));
const {
  fromAnnotation,
  fromMarkdown,
  matchesMarkdownSourceSlice,
  createSemanticSourceResolver,
} = require(semanticModule);
const { validateSource } = require("../plugin/learning/service.cjs");

test("Learning source validation accepts the real PDF and Markdown SemanticAnchor factory shapes", async () => {
  const pdf = fromAnnotation({
    uuid: "annotation-live", kind: "Highlight", pageIndex: 1,
    editorPayload: { text: "stored quote" },
  }, {
    documentId: "document-1", docKey: "012345abcdef", sourcePath: "Library/Book.pdf",
    sourceHash: `sha256-v1:${"a".repeat(64)}`, pageIdentity: "page-identity-2",
  });
  assert.equal(pdf.sourceRange, null, "the C factory explicitly emits sourceRange:null for ordinary PDF evidence");
  assert.deepEqual(validateSource(pdf), pdf);

  const markdown = fromMarkdown({ sourcePath: "Notes/Quote.md", offset: 5, endOffset: 17,
    line: 1, text: "quoted words" });
  assert.deepEqual(markdown, {
    target: { kind: "markdown", id: "md:5:17" },
    documentId: null, docKey: null, sourcePath: "Notes/Quote.md", sourceHash: null,
    pageIndex: null, pageIdentity: null, targetText: "quoted words", targetTextSource: "captured",
    evidenceKind: "markdown",
    sourceRange: { startOffset: 5, endOffset: 17, line: 1, text: "quoted words" },
  });
  assert.deepEqual(validateSource(markdown), markdown);
  assert.throws(() => validateSource({ ...markdown, targetText: "similar words" }),
    (error) => error.code === "LEARNING_SOURCE_INVALID");

  const resolverFor = (currentText) => createSemanticSourceResolver({
    verifyMarkdown: async (anchor) => matchesMarkdownSourceSlice(anchor, currentText)
      ? { status: "verified", sourceCurrent: true, pageCurrent: true, anchor }
      : { status: "invalid", sourceCurrent: false, pageCurrent: false, anchor },
  });
  assert.equal((await resolverFor("xxxx quoted words tail")(markdown)).status, "verified");
  assert.equal((await resolverFor("xxxx quoted word! tail")(markdown)).code, "TARGET_UNRESOLVED",
    "the exact source slice must remain current at confirmation time");
});
