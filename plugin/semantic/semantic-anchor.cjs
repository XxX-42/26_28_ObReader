"use strict";

const TARGET_KINDS = new Set(["annotation", "selection", "page", "markdown"]);
const TARGET_TEXT_SOURCES = new Set(["captured", "stored", "recovered", "unavailable"]);
const EVIDENCE_KINDS = new Set(["annotation", "reader-anchor", "context", "backlink", "markdown"]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function textEvidence(value, source) {
  const text = nonEmptyString(value);
  if (!text || !TARGET_TEXT_SOURCES.has(source) || source === "unavailable") {
    return { targetText: "", targetTextSource: "unavailable" };
  }
  return { targetText: text, targetTextSource: source };
}

function copySourceRange(value) {
  if (!value || typeof value !== "object") return null;
  const startOffset = Number.isSafeInteger(value.startOffset) ? value.startOffset
    : Number.isSafeInteger(value.offset) ? value.offset : null;
  const endOffset = Number.isSafeInteger(value.endOffset) ? value.endOffset : null;
  const line = Number.isSafeInteger(value.line) && value.line >= 0 ? value.line : null;
  const text = typeof value.text === "string" ? value.text : null;
  if (startOffset === null && endOffset === null && line === null && text === null) return null;
  return { startOffset, endOffset, line, text };
}

function copyAnnotationVersion(value) {
  if (!value || typeof value !== "object") return null;
  const version = value.version && typeof value.version === "object"
    ? {
      rev: Number.isSafeInteger(value.version.rev) ? value.version.rev : null,
      deviceId: nonEmptyString(value.version.deviceId),
      seq: Number.isSafeInteger(value.version.seq) ? value.version.seq : null,
    }
    : null;
  const clock = value.clock && typeof value.clock === "object"
    ? {
      timestamp: Number.isSafeInteger(value.clock.timestamp) ? value.clock.timestamp : null,
      logical: Number.isSafeInteger(value.clock.logical) ? value.clock.logical : null,
      deviceId: nonEmptyString(value.clock.deviceId),
      opId: nonEmptyString(value.clock.opId),
    }
    : null;
  if (!version && !clock) return null;
  return { version, clock };
}

function makeSemanticAnchor({
  target,
  documentId = null,
  docKey = null,
  sourcePath = null,
  sourceHash = null,
  pageIndex = null,
  pageIdentity = null,
  targetText = "",
  targetTextSource = "unavailable",
  evidenceKind = null,
  sourceRange = null,
  contextId = null,
  annotationVersion = null,
} = {}) {
  if (!target || !TARGET_KINDS.has(target.kind) || !nonEmptyString(target.id) || target.id.length > 512) {
    return null;
  }
  if (evidenceKind !== null && !EVIDENCE_KINDS.has(evidenceKind)) return null;
  const evidence = textEvidence(targetText, targetTextSource);
  const anchor = {
    target: { kind: target.kind, id: target.id },
    documentId: nonEmptyString(documentId),
    docKey: nonEmptyString(docKey),
    sourcePath: nonEmptyString(sourcePath),
    sourceHash: nonEmptyString(sourceHash),
    pageIndex: Number.isSafeInteger(pageIndex) && pageIndex >= 0 ? pageIndex : null,
    pageIdentity: nonEmptyString(pageIdentity),
    targetText: evidence.targetText,
    targetTextSource: evidence.targetTextSource,
    evidenceKind,
    sourceRange: copySourceRange(sourceRange),
  };
  if (nonEmptyString(contextId)) anchor.contextId = contextId;
  const copiedAnnotationVersion = copyAnnotationVersion(annotationVersion);
  if (copiedAnnotationVersion) anchor.annotationVersion = copiedAnnotationVersion;
  return anchor;
}

function fromAnnotation(annotation, identity = {}) {
  if (!annotation || typeof annotation !== "object") return null;
  const uuid = nonEmptyString(annotation.uuid) || nonEmptyString(annotation.id);
  const kind = annotation.kind;
  const payload = annotation.editorPayload && typeof annotation.editorPayload === "object"
    ? annotation.editorPayload
    : annotation.editor && typeof annotation.editor === "object"
      ? annotation.editor
      : annotation.payload?.editor && typeof annotation.payload.editor === "object"
        ? annotation.payload.editor
        : annotation.value && typeof annotation.value === "object" ? annotation.value : null;
  const storedText = kind === "FreeText" ? payload?.value : kind === "Highlight" ? payload?.text : null;
  const targetText = annotation.targetText ?? storedText;
  const targetTextSource = annotation.targetTextSource || identity.targetTextSource ||
    (nonEmptyString(storedText) ? "stored" : "unavailable");
  return makeSemanticAnchor({
    target: { kind: "annotation", id: uuid },
    documentId: identity.documentId ?? annotation.documentId,
    docKey: identity.docKey ?? annotation.docKey,
    sourcePath: identity.sourcePath ?? annotation.sourcePath,
    sourceHash: identity.sourceHash ?? annotation.sourceHash,
    pageIndex: annotation.pageIndex,
    pageIdentity: identity.pageIdentity ?? annotation.pageIdentity,
    targetText,
    targetTextSource,
    evidenceKind: "annotation",
    annotationVersion: {
      version: annotation.version,
      clock: annotation.clock,
    },
  });
}

function fromReaderAnchor(readerAnchor, identity = {}) {
  if (!readerAnchor || typeof readerAnchor !== "object") return null;
  return makeSemanticAnchor({
    target: { kind: "selection", id: readerAnchor.anchorId },
    documentId: readerAnchor.documentId,
    docKey: readerAnchor.docKey,
    sourcePath: identity.sourcePath ?? readerAnchor.sourcePath,
    sourceHash: readerAnchor.sourceHash,
    pageIndex: readerAnchor.pageIndexHint,
    pageIdentity: readerAnchor.pageIdentity,
    targetText: readerAnchor.exactQuote,
    targetTextSource: "captured",
    evidenceKind: "reader-anchor",
  });
}

function fromContext(context, identity = {}) {
  if (!context || typeof context !== "object") return null;
  const readerAnchor = context.readerAnchor || context.sourceAnchor || context.selectionAnchor ||
    context.anchor || context;
  if (!readerAnchor || typeof readerAnchor !== "object") return null;
  const base = fromReaderAnchor(readerAnchor, {
    sourcePath: identity.sourcePath ?? context.sourcePath,
  });
  if (!base) return null;
  base.evidenceKind = "context";
  base.contextId = nonEmptyString(context.contextId) || nonEmptyString(context.id) || null;
  if (nonEmptyString(context.targetText)) {
    const evidence = textEvidence(context.targetText,
      context.targetTextSource || identity.targetTextSource || "captured");
    base.targetText = evidence.targetText;
    base.targetTextSource = evidence.targetTextSource;
  }
  return base;
}

function fromBacklink(row, identity = {}) {
  if (!row || typeof row !== "object" || !row.target || typeof row.target !== "object") return null;
  const sourceRange = {
    startOffset: row.offset,
    endOffset: row.endOffset,
    line: row.line,
    // displayText is not a source slice and must not be promoted to exact evidence.
    text: identity.sourceText ?? row.sourceText,
  };
  return makeSemanticAnchor({
    target: row.target,
    documentId: identity.documentId ?? row.documentId,
    docKey: identity.docKey ?? row.docKey,
    sourcePath: row.sourcePath,
    sourceHash: identity.sourceHash ?? row.sourceHash,
    pageIndex: identity.pageIndex,
    pageIdentity: identity.pageIdentity,
    targetText: identity.targetText ?? row.targetText,
    targetTextSource: identity.targetTextSource ?? row.targetTextSource ?? "unavailable",
    evidenceKind: "backlink",
    sourceRange,
  });
}

function fromMarkdown(selection, identity = {}) {
  if (!selection || typeof selection !== "object") return null;
  const sourcePath = nonEmptyString(selection.sourcePath) || nonEmptyString(identity.sourcePath);
  const offset = selection.offset;
  const endOffset = selection.endOffset;
  const exactText = typeof selection.text === "string" ? selection.text : selection.targetText;
  if (!sourcePath || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(endOffset) || endOffset <= offset) return null;
  const targetId = nonEmptyString(selection.id) || `md:${offset}:${endOffset}`;
  return makeSemanticAnchor({
    target: { kind: "markdown", id: targetId },
    documentId: identity.documentId ?? selection.documentId,
    docKey: identity.docKey ?? selection.docKey,
    sourcePath,
    sourceHash: identity.sourceHash ?? selection.sourceHash,
    pageIndex: identity.pageIndex,
    pageIdentity: identity.pageIdentity,
    targetText: exactText,
    targetTextSource: nonEmptyString(exactText) ? "captured" : "unavailable",
    evidenceKind: "markdown",
    sourceRange: { startOffset: offset, endOffset, line: selection.line, text: exactText },
  });
}

function matchesMarkdownSourceSlice(anchor, markdownText) {
  const range = anchor?.sourceRange;
  if (typeof markdownText !== "string" || !range ||
      !Number.isSafeInteger(range.startOffset) || range.startOffset < 0 ||
      !Number.isSafeInteger(range.endOffset) || range.endOffset <= range.startOffset ||
      range.endOffset > markdownText.length || typeof range.text !== "string") return false;
  const currentSlice = markdownText.slice(range.startOffset, range.endOffset);
  if (currentSlice !== range.text) return false;
  return anchor.evidenceKind !== "markdown" ||
    (typeof anchor.targetText === "string" && currentSlice === anchor.targetText);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hasVerifiedEvidence(result, anchor, { needsPage = false } = {}) {
  if (!result || result.status !== "verified" || result.sourceCurrent !== true ||
      (needsPage && result.pageCurrent !== true)) return false;
  const evidence = result.anchor ?? result.source;
  return evidence && stableJson(evidence) === stableJson(anchor);
}

function createSemanticSourceResolver({
  verifyRouting,
  verifyReaderAnchor,
  verifyAnnotation,
  verifyContext,
  verifyBacklink,
  verifyMarkdown,
} = {}) {
  const fail = (anchor, reason, routeVerified = false) => {
    const hasPageFallback = routeVerified && anchor &&
      Number.isSafeInteger(anchor.pageIndex) && anchor.pageIndex >= 0 &&
      nonEmptyString(anchor.pageIdentity);
    return {
      status: "unresolved",
      code: "TARGET_UNRESOLVED",
      reason,
      sourceCurrent: false,
      pageCurrent: false,
      exact: false,
      anchor: anchor || null,
      pageFallback: hasPageFallback ? {
        kind: "page",
        id: anchor.pageIdentity,
        pageIndex: anchor.pageIndex,
        exact: false,
      } : null,
    };
  };

  // ownerContext is request-scoped routing context (for example a learning
  // item ID). It is intentionally never copied into the SemanticAnchor.
  return async function resolveSource(anchor, ownerContext = null) {
    if (!anchor || !anchor.target || !TARGET_KINDS.has(anchor.target.kind) ||
        !nonEmptyString(anchor.target.id) || !EVIDENCE_KINDS.has(anchor.evidenceKind)) {
      return fail(anchor, "semantic-anchor-invalid");
    }
    const isMarkdown = anchor.target.kind === "markdown" || anchor.evidenceKind === "markdown";
    let routeResult = null;
    if (!isMarkdown) {
      if (typeof verifyRouting !== "function") return fail(anchor, "routing-verifier-unavailable");
      try { routeResult = await verifyRouting(anchor, ownerContext); }
      catch { return fail(anchor, "routing-verifier-failed"); }
      if (!hasVerifiedEvidence(routeResult, anchor, { needsPage: Boolean(anchor.pageIdentity) })) {
        return fail(anchor, routeResult?.code || "source-unverified");
      }
    }

    const verifiers = {
      "reader-anchor": verifyReaderAnchor,
      annotation: verifyAnnotation,
      context: verifyContext,
      backlink: verifyBacklink,
      markdown: verifyMarkdown,
    };
    const verifier = verifiers[anchor.evidenceKind];
    if (typeof verifier !== "function") return fail(anchor, `${anchor.evidenceKind}-verifier-unavailable`, !isMarkdown);
    let targetResult;
    try { targetResult = await verifier(anchor, ownerContext); }
    catch { return fail(anchor, `${anchor.evidenceKind}-verifier-failed`, !isMarkdown); }
    const needsPage = Boolean(anchor.pageIdentity);
    if (!hasVerifiedEvidence(targetResult, anchor, { needsPage })) {
      return fail(anchor, targetResult?.code || "target-unverified", !isMarkdown);
    }

    // A backlink has two independently verified sides: its Markdown citation and
    // the existing Reader target it points at. Geometry-derived text is never
    // used to repair or rebind either identity.
    if (anchor.evidenceKind === "backlink") {
      // A page target is proven by the already-current route/page identity;
      // it has no separate Reader Anchor Store record.
      if (anchor.target.kind !== "page") {
        const targetVerifier = anchor.target.kind === "annotation" ? verifyAnnotation : verifyReaderAnchor;
        if (typeof targetVerifier !== "function") return fail(anchor, "target-verifier-unavailable", true);
        let readerTargetResult;
        try { readerTargetResult = await targetVerifier(anchor, ownerContext); }
        catch { return fail(anchor, "target-verifier-failed", true); }
        if (!hasVerifiedEvidence(readerTargetResult, anchor, { needsPage })) {
          return fail(anchor, readerTargetResult?.code || "target-unverified", true);
        }
      }
    }

    return {
      status: "verified",
      code: null,
      sourceCurrent: true,
      pageCurrent: true,
      exact: true,
      anchor,
      source: anchor,
      pageFallback: null,
    };
  };
}

module.exports = {
  TARGET_KINDS,
  TARGET_TEXT_SOURCES,
  makeSemanticAnchor,
  fromAnnotation,
  fromReaderAnchor,
  fromContext,
  fromBacklink,
  fromMarkdown,
  matchesMarkdownSourceSlice,
  createSemanticSourceResolver,
  hasVerifiedEvidence,
};
