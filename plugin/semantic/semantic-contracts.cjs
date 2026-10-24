"use strict";

const { makeSemanticAnchor, hasVerifiedEvidence } = require("./semantic-anchor.cjs");

const SEMANTIC_ANCHOR_CONTRACT_V1 = "SemanticAnchorContractV1";

function projectResolutionStatus(result, { explicitPageFallback = false } = {}) {
  if (result?.status === "verified" && result.sourceCurrent === true && result.pageCurrent === true && result.exact === true) {
    return { status: "VERIFIED", exact: true, pageFallback: null };
  }
  if (explicitPageFallback === true && result?.pageFallback && result.pageFallback.exact === false) {
    return { status: "RECOVERABLE", exact: false, pageFallback: { ...result.pageFallback, exact: false } };
  }
  return { status: "TARGET_UNRESOLVED", exact: false, pageFallback: null };
}

// This is an API descriptor. It is deliberately separate from Learning's
// canonical source object, whose target remains the flat { kind, id } wire.
function createSemanticAnchorContractV1(anchor, {
  ownerKind = null, ownerId = null, bindingId = null, currentPath = null, resolution = null,
  explicitPageFallback = false,
} = {}) {
  const normalized = makeSemanticAnchor(anchor || {});
  if (!normalized) return null;
  // A successful check belongs only to the exact anchor it verified. Status
  // booleans alone must not lend another target or source an exact contract.
  const checkedResolution = resolution?.status === "verified" &&
    !hasVerifiedEvidence(resolution, anchor, { needsPage: true }) ? null : resolution;
  const projected = projectResolutionStatus(checkedResolution, { explicitPageFallback });
  return {
    contract: SEMANTIC_ANCHOR_CONTRACT_V1,
    version: 1,
    target: { kind: normalized.target.kind, id: normalized.target.id },
    evidenceKind: normalized.evidenceKind,
    documentId: normalized.documentId,
    docKey: normalized.docKey,
    sourcePath: typeof currentPath === "string" && currentPath ? currentPath : normalized.sourcePath,
    sourceHash: normalized.sourceHash,
    pageIndex: normalized.pageIndex,
    pageIdentity: normalized.pageIdentity,
    targetText: normalized.targetText,
    targetTextSource: normalized.targetTextSource,
    sourceRange: normalized.sourceRange,
    ...(normalized.contextId ? { contextId: normalized.contextId } : {}),
    ...(normalized.annotationVersion ? { annotationVersion: normalized.annotationVersion } : {}),
    owner: ownerKind && ownerId ? { kind: ownerKind, id: ownerId } : null,
    bindingId: typeof bindingId === "string" && bindingId ? bindingId : null,
    status: projected.status,
    exact: projected.exact,
    pageFallback: projected.pageFallback,
  };
}

module.exports = { SEMANTIC_ANCHOR_CONTRACT_V1, projectResolutionStatus, createSemanticAnchorContractV1 };
