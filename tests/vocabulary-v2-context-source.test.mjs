import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const { createContextSourceVerifier } = require("../plugin/vocabulary/context-source.cjs");

function fixture() {
  const hash = "sha256-v1:" + "a".repeat(64);
  const anchor = { schemaVersion: 1, kind: "obreader-selection-anchor", anchorId: "selection-one",
    documentId: "stable-document", docKey: "012345abcdef", sourceHash: hash, pageIdentity: "page-one",
    pageIndexHint: 0, pageCount: 1, orderedPageIdentityDigest: hash, textPosition: { start: 0, end: 4 },
    exactQuote: "walk", prefix: "", suffix: "", geometry: null };
  const state = { route: { documentId: anchor.documentId, docKey: anchor.docKey, source: { sourceHash: hash }, sourcePath: "Books/A.pdf" },
    evidence: { documentId: anchor.documentId, docKey: anchor.docKey, sourceHash: hash, sourcePath: "Books/A.pdf", verified: true, orderedPageIdentities: ["page-one"] }, exists: true, hashCalls: 0 };
  const verify = createContextSourceVerifier({ anchorStore: { get: async () => structuredClone(anchor) },
    documentStore: { documentForIdentity: async () => structuredClone(state.route) },
    getFileByPath: (path) => state.exists && path === state.route.sourcePath ? { path } : null,
    getVerifiedSource: async () => structuredClone(state.evidence),
    hashOrderedPages: async () => { state.hashCalls++; return hash; } });
  return { anchor, state, verify };
}

test("Context source follows a verified document rename without changing identity or scanning PDF", async () => {
  const { anchor, state, verify } = fixture();
  assert.equal((await verify(anchor)).status, "verified");
  state.route.sourcePath = "Archive/B.pdf";
  state.evidence.sourcePath = "Archive/B.pdf";
  const result = await verify(anchor);
  assert.equal(result.status, "verified");
  assert.equal(result.sourcePath, "Archive/B.pdf");
  assert.equal(result.anchor.anchorId, "selection-one");
  assert.equal(state.hashCalls, 2, "only existing page identity arrays are hashed; no PDF/text API is provided");
});

test("Context source rejects stale PDFs, unverified sessions, missing files and changed page identity", async () => {
  for (const change of [
    (s) => { s.evidence.sourceHash = "sha256-v1:" + "b".repeat(64); },
    (s) => { s.evidence.verified = false; },
    (s) => { s.exists = false; },
    (s) => { s.evidence.orderedPageIdentities = ["another-page"]; },
    (s) => { s.route.documentId = "different-document"; },
  ]) {
    const { anchor, state, verify } = fixture();
    change(state);
    const result = await verify(anchor);
    assert.equal(result.status, "invalid");
    assert.equal(result.sourceCurrent, false);
  }
  const { anchor, verify } = fixture();
  assert.equal((await verify({ ...anchor, exactQuote: "changed" })).code, "VOCAB_CONTEXT_ANCHOR_CHANGED");
});
