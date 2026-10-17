"use strict";

const { validateSelectionAnchor } = require("../reader-anchor-store.cjs");
const { canonicalStringify } = require("./canonical.cjs");

// Context verification uses the host's already verified document/page evidence.
// It never repairs an Anchor by coordinates, scans PDF text, or opens files.
function createContextSourceVerifier({ anchorStore, documentStore, getFileByPath, getVerifiedSource, hashOrderedPages } = {}) {
  if (typeof anchorStore?.get !== "function" || typeof documentStore?.documentForIdentity !== "function" ||
      typeof getFileByPath !== "function" || typeof getVerifiedSource !== "function" || typeof hashOrderedPages !== "function") {
    throw new TypeError("Context source verification requires existing Anchor, routing and verified-page adapters.");
  }
  return async function verifyContextSource(supplied) {
    const invalid = (code) => ({ status: "invalid", sourceCurrent: false, pageCurrent: false, code });
    try { validateSelectionAnchor(supplied); } catch { return invalid("VOCAB_CONTEXT_ANCHOR_INVALID"); }
    let anchor, route;
    try {
      anchor = await anchorStore.get(supplied.docKey, supplied.anchorId, supplied.documentId);
      if (!anchor || canonicalStringify(anchor) !== canonicalStringify(supplied)) return invalid("VOCAB_CONTEXT_ANCHOR_CHANGED");
      route = await documentStore.documentForIdentity({ documentId: anchor.documentId, docKey: anchor.docKey });
    } catch { return invalid("VOCAB_CONTEXT_IDENTITY_UNAVAILABLE"); }
    if (!route || route.documentId !== anchor.documentId || route.docKey !== anchor.docKey ||
        route.source?.sourceHash !== anchor.sourceHash || typeof route.sourcePath !== "string" ||
        !getFileByPath(route.sourcePath)) return invalid("VOCAB_CONTEXT_SOURCE_MISMATCH");
    const evidence = await getVerifiedSource(anchor.documentId, anchor.docKey, route.sourcePath);
    if (!evidence || evidence.documentId !== anchor.documentId || evidence.docKey !== anchor.docKey ||
        evidence.sourceHash !== anchor.sourceHash || evidence.sourcePath !== route.sourcePath ||
        evidence.verified !== true || !Array.isArray(evidence.orderedPageIdentities) ||
        evidence.orderedPageIdentities.length !== anchor.pageCount ||
        evidence.orderedPageIdentities[anchor.pageIndexHint] !== anchor.pageIdentity) {
      return invalid("VOCAB_CONTEXT_CURRENT_SOURCE_NOT_VERIFIED");
    }
    const orderedDigest = await hashOrderedPages(evidence.orderedPageIdentities);
    if (orderedDigest !== anchor.orderedPageIdentityDigest) return invalid("VOCAB_CONTEXT_PAGE_ORDER_MISMATCH");
    // The caller may have closed/reopened or renamed the Reader during the
    // digest. Obtain current evidence again rather than trusting a stale view.
    const current = await getVerifiedSource(anchor.documentId, anchor.docKey, route.sourcePath);
    if (!current || current.verified !== true || current.documentId !== evidence.documentId ||
        current.docKey !== evidence.docKey || current.sourceHash !== evidence.sourceHash ||
        current.sourcePath !== evidence.sourcePath ||
        canonicalStringify(current.orderedPageIdentities) !== canonicalStringify(evidence.orderedPageIdentities)) {
      return invalid("VOCAB_CONTEXT_SOURCE_SESSION_CHANGED");
    }
    return { status: "verified", sourceCurrent: true, pageCurrent: true, anchor, sourcePath: route.sourcePath };
  };
}

module.exports = { createContextSourceVerifier };
