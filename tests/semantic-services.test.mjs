import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createAnnotationSidebarService, createBacklinkService } = require("../plugin/semantic/services.cjs");
const { createSemanticAnchorContractV1, projectResolutionStatus } = require("../plugin/semantic/semantic-contracts.cjs");
const { createSemanticSourceResolver, fromBacklink } = require("../plugin/semantic/semantic-anchor.cjs");

test("semantic sidebar and backlink facades delegate every operation without local state", async () => {
  const calls = [];
  const operation = name => (...args) => { calls.push([name, args]); return Promise.resolve({ name, args }); };
  const sidebar = createAnnotationSidebarService({ list: operation("list"), get: operation("get"),
    navigate: operation("navigate"), createReviewDraft: operation("createReviewDraft") });
  const backlink = createBacklinkService({ resolve: operation("resolve"), openPdfTarget: operation("openPdfTarget"),
    openMarkdownSource: operation("openMarkdownSource"), listSources: operation("listSources") });
  const input = { uuid: "annotation-1", pageIndex: 4 };
  assert.deepEqual(await sidebar.list({ cursor: "page-1" }), { name: "list", args: [{ cursor: "page-1" }] });
  assert.deepEqual(await sidebar.get(input.uuid), { name: "get", args: [input.uuid] });
  assert.deepEqual(await sidebar.navigate(input), { name: "navigate", args: [input] });
  assert.deepEqual(await sidebar.createReviewDraft(input), { name: "createReviewDraft", args: [input] });
  assert.deepEqual(await backlink.resolve(input), { name: "resolve", args: [input] });
  assert.deepEqual(await backlink.openPdfTarget(input), { name: "openPdfTarget", args: [input] });
  assert.deepEqual(await backlink.openMarkdownSource(input), { name: "openMarkdownSource", args: [input] });
  assert.deepEqual(await backlink.listSources(input), { name: "listSources", args: [input] });
  assert.deepEqual(calls.map(([name]) => name), ["list", "get", "navigate", "createReviewDraft", "resolve",
    "openPdfTarget", "openMarkdownSource", "listSources"]);
  assert.equal(Object.isFrozen(sidebar), true);
  assert.equal(Object.isFrozen(backlink), true);
});

test("semantic facades reject missing host operations rather than creating fallback state", () => {
  assert.throws(() => createAnnotationSidebarService({ list() {} }), /get must be a function/);
  assert.throws(() => createBacklinkService({ resolve() {} }), /openPdfTarget must be a function/);
});

test("SemanticAnchorContractV1 keeps flat target wire and gates exact status projections", () => {
  const anchor = { target: { kind: "markdown", id: "md:2:7" }, evidenceKind: "markdown",
    sourcePath: "Notes/A.md", sourceHash: null, documentId: null, docKey: null, pageIndex: null,
    pageIdentity: null, targetText: "quote", targetTextSource: "captured",
    sourceRange: { startOffset: 2, endOffset: 7, line: 0, text: "quote" }, contextId: "context-1",
    annotationVersion: { version: { rev: 3, deviceId: "device-1", seq: 8 },
      clock: { timestamp: 100, logical: 2, deviceId: "device-1", opId: "device-1:8" } } };
  const verified = { status: "verified", sourceCurrent: true, pageCurrent: true, exact: true, anchor };
  const descriptor = createSemanticAnchorContractV1(anchor, { ownerKind: "learning-item", ownerId: "item-1",
    bindingId: "binding-1", resolution: verified });
  assert.equal(descriptor.contract, "SemanticAnchorContractV1");
  assert.deepEqual(descriptor.target, { kind: "markdown", id: "md:2:7" });
  assert.deepEqual(descriptor.owner, { kind: "learning-item", id: "item-1" });
  assert.equal(descriptor.status, "VERIFIED");
  assert.equal(descriptor.exact, true);
  assert.equal(descriptor.contextId, "context-1", "the v1 view contract preserves the existing optional context identity");
  assert.deepEqual(descriptor.annotationVersion, anchor.annotationVersion,
    "the v1 view contract preserves the existing optional annotation revision evidence");
  assert.equal(Object.hasOwn(anchor, "owner"), false, "routing identity stays outside canonical anchor data");
  const fallback = { status: "unresolved", pageFallback: { kind: "page", id: "page-x", pageIndex: 3, exact: false } };
  assert.equal(projectResolutionStatus(fallback).status, "TARGET_UNRESOLVED");
  assert.deepEqual(projectResolutionStatus(fallback, { explicitPageFallback: true }), {
    status: "RECOVERABLE", exact: false,
    pageFallback: { kind: "page", id: "page-x", pageIndex: 3, exact: false },
  });
  assert.equal(projectResolutionStatus({ ...verified, exact: false }).status, "TARGET_UNRESOLVED");
});

test("backlink resolution forwards transient owner context to exact Markdown and Reader target checks", async () => {
  const ownerContext = { ownerKind: "learning-item", ownerId: "learning:v1:route-owner" };
  const anchor = fromBacklink({ sourcePath: "Notes/Quote.md", target: { kind: "selection", id: "sel-1" },
    docKey: "012345abcdef", documentId: "document-1", offset: 8, endOffset: 48,
    sourceText: "[[Book.pdf#obreader=sel.sel-1|exact quote]]" }, {
    sourceHash: `sha256-v1:${"c".repeat(64)}`, pageIndex: 2, pageIdentity: "page-3",
    targetText: "exact quote", targetTextSource: "stored",
  });
  const seen = [];
  const verified = value => ({ status: "verified", sourceCurrent: true, pageCurrent: true, anchor: value });
  const resolver = createSemanticSourceResolver({
    verifyRouting: async (value, context) => { seen.push(["routing", context]); return verified(value); },
    verifyBacklink: async (value, context) => { seen.push(["markdown", context]); return verified(value); },
    verifyReaderAnchor: async (value, context) => { seen.push(["reader", context]); return verified(value); },
  });
  const result = await resolver(anchor, ownerContext);
  assert.equal(result.status, "verified");
  assert.deepEqual(seen.map(([step]) => step), ["routing", "markdown", "reader"]);
  assert.ok(seen.every(([, context]) => context === ownerContext));
  assert.equal(Object.hasOwn(anchor, "ownerContext"), false, "owner routing stays request-scoped");
});


test("SemanticAnchorContractV1 cannot borrow exact verification from another target", () => {
  const anchor = fromBacklink({ sourcePath: "Notes/Quote.md",
    target: { kind: "annotation", id: "annotation-1" }, offset: 0, endOffset: 5,
    sourceText: "quote" });
  const verified = { status: "verified", sourceCurrent: true, pageCurrent: true,
    exact: true, anchor };
  const other = { ...anchor, target: { kind: "annotation", id: "annotation-2" } };
  assert.equal(createSemanticAnchorContractV1(other, { resolution: verified }).status,
    "TARGET_UNRESOLVED", "identical quote evidence cannot verify another UUID");
  assert.equal(createSemanticAnchorContractV1(anchor, {
    resolution: { ...verified, anchor: undefined },
  }).exact, false, "status booleans without an anchor echo do not prove identity");
  assert.equal(createSemanticAnchorContractV1(anchor, {
    resolution: { ...verified, anchor: { ...anchor, sourcePath: "Notes/Other.md" } },
  }).exact, false, "verification of a different Markdown source cannot be borrowed");
  assert.equal(createSemanticAnchorContractV1(anchor, {
    resolution: { ...verified, anchor: Object.fromEntries(Object.entries(anchor).reverse()) },
  }).status, "VERIFIED", "structural identity does not depend on object key order");
});
