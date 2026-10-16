/**
 * Vocabulary matching helpers for page-scoped PDF text tokens.
 *
 * A PageToken has this shape:
 *   { index: number, rawSurface: string, surfaceKey: string,
 *     segments: Array<{ textNode: Text, startOffset: number, endOffset: number }> }
 * Segment offsets are half-open UTF-16 offsets into the original Text node.
 * `tokens` passed to getSelectedPageTokens must already be in reading order
 * for one page. Selection is based on segment/Range intersection, never on
 * flattened text or Selection#toString().
 */

export class VocabularySelectionError extends Error {
  constructor(code, message, selectedCount = null) {
    super(message);
    this.name = "VocabularySelectionError";
    this.code = code;
    this.selectedCount = selectedCount;
  }
}

function containsNode(root, node) {
  if (!root || !node) return false;
  if (root === node) return true;
  if (typeof root.contains === "function") {
    try {
      return root.contains(node);
    } catch {
      // Keep the helper usable with lightweight fake DOM nodes in tests.
    }
  }
  for (let current = node.parentNode; current; current = current.parentNode) {
    if (current === root) return true;
  }
  return false;
}

function isValidOffsetPair(segment) {
  return Number.isInteger(segment?.startOffset) &&
    Number.isInteger(segment?.endOffset) &&
    segment.startOffset >= 0 &&
    segment.endOffset > segment.startOffset;
}

function textNodeLength(node) {
  if (Number.isInteger(node?.length)) return node.length;
  if (typeof node?.data === "string") return node.data.length;
  return null;
}

function boundaryOffsetLimit(node) {
  const textLength = textNodeLength(node);
  if (textLength != null) return textLength;
  if (Number.isInteger(node?.childNodes?.length)) return node.childNodes.length;
  if (Number.isInteger(node?.children?.length)) return node.children.length;
  return null;
}

function validatePageTokens(tokens, pageRoot) {
  if (!Array.isArray(tokens)) {
    throw new TypeError("tokens must be an array of PageToken objects");
  }
  for (const token of tokens) {
    if (!token || typeof token.surfaceKey !== "string" || !Array.isArray(token.segments) || token.segments.length === 0) {
      throw new TypeError("Each PageToken must have a surfaceKey and at least one segment");
    }
    for (const segment of token.segments) {
      if (!segment?.textNode || !isValidOffsetPair(segment)) {
        throw new TypeError("Each PageToken segment needs a textNode and valid half-open offsets");
      }
      const length = textNodeLength(segment.textNode);
      if (length != null && segment.endOffset > length) {
        throw new TypeError("PageToken segment extends beyond its original Text node");
      }
      if (!containsNode(pageRoot, segment.textNode)) {
        throw new VocabularySelectionError("cross-page", "PageToken segment is outside the requested page");
      }
    }
  }
}

function isCollapsedRange(range) {
  return range.collapsed === true || (
    range.startContainer === range.endContainer &&
    range.startOffset === range.endOffset
  );
}

function validateRange(range, pageRoot) {
  if (!range || !range.startContainer || !range.endContainer ||
      !Number.isInteger(range.startOffset) || !Number.isInteger(range.endOffset) ||
      range.startOffset < 0 || range.endOffset < 0) {
    throw new VocabularySelectionError("invalid-range", "A valid DOM Range is required");
  }
  const startLimit = boundaryOffsetLimit(range.startContainer);
  const endLimit = boundaryOffsetLimit(range.endContainer);
  if ((startLimit != null && range.startOffset > startLimit) ||
      (endLimit != null && range.endOffset > endLimit)) {
    throw new VocabularySelectionError("invalid-range", "Range offset is outside its boundary node");
  }
  if (!containsNode(pageRoot, range.startContainer) || !containsNode(pageRoot, range.endContainer) ||
      (range.commonAncestorContainer && !containsNode(pageRoot, range.commonAncestorContainer))) {
    throw new VocabularySelectionError("cross-page", "Selection must stay within one page");
  }
  if (isCollapsedRange(range)) {
    throw new VocabularySelectionError("token-count", "Select at least two tokens", 0);
  }
}

function segmentIntersectsRange(segment, range) {
  const { textNode: node, startOffset, endOffset } = segment;
  const startNode = range.startContainer;
  const endNode = range.endContainer;

  // Exact half-open offset intersection for one-node selections and boundaries.
  if (startNode === endNode && node === startNode) {
    return Math.max(startOffset, range.startOffset) < Math.min(endOffset, range.endOffset);
  }
  if (node === startNode) return endOffset > range.startOffset;
  if (node === endNode) return startOffset < range.endOffset;

  // For intermediate original Text nodes, native Range knows document order.
  if (typeof range.intersectsNode === "function") {
    try {
      return range.intersectsNode(node);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Resolve a DOM Range to the intersected page tokens in their supplied reading
 * order. Tokens are returned whole when any segment overlaps the Range.
 *
 * Options: { pageRoot, minTokens = 2, maxTokens = 12 }. The range endpoints
 * and every token segment must belong to pageRoot. Invalid,
 * cross-page, or out-of-bounds selections throw VocabularySelectionError; an
 * overlong selection is rejected rather than truncated.
 */
export function getSelectedPageTokens(range, tokens, {
  pageRoot,
  minTokens = 2,
  maxTokens = 12,
} = {}) {
  if (!Number.isInteger(minTokens) || !Number.isInteger(maxTokens) || minTokens < 1 || maxTokens > 12 || maxTokens < minTokens) {
    throw new TypeError("minTokens and maxTokens must be integer bounds within 1–12");
  }
  if (!pageRoot) throw new TypeError("pageRoot is required");
  validateRange(range, pageRoot);
  validatePageTokens(tokens, pageRoot);

  const selected = tokens.filter((token) => token.segments.some((segment) => segmentIntersectsRange(segment, range)));
  if (selected.length < minTokens || selected.length > maxTokens) {
    throw new VocabularySelectionError(
      "token-count",
      `Selection must contain ${minTokens}–${maxTokens} tokens (found ${selected.length})`,
      selected.length,
    );
  }
  return selected;
}

function surfaceKeysForTokens(tokens) {
  if (!Array.isArray(tokens)) throw new TypeError("tokens must be an array");
  return tokens.map((token) => {
    const key = token?.surfaceKey;
    if (typeof key !== "string") throw new TypeError("Every token must provide a string surfaceKey");
    return key;
  });
}

/**
 * Find exact surfaceKey phrase matches. Records have the shape
 * `{ surfaceKeys: string[], ...metadata }`. Overlaps are resolved in reading
 * order: at each start, the longest phrase wins, then record input order; after
 * a match, scanning advances past it. Accepted matches do not overlap.
 * No normalization, case folding, or lemmatization is performed.
 *
 * Each result is `{ startIndex, endIndex, record }`, with endIndex exclusive.
 */
export function matchPhrases(tokens, records) {
  const tokenKeys = surfaceKeysForTokens(tokens);
  if (!Array.isArray(records)) throw new TypeError("records must be an array");

  const root = { children: new Map(), record: null, length: 0 };
  records.forEach((record) => {
    if (!record || !Array.isArray(record.surfaceKeys) || record.surfaceKeys.length < 2 || record.surfaceKeys.length > 12 ||
        record.surfaceKeys.some((key) => typeof key !== "string")) {
      throw new TypeError("Each phrase record must have 2–12 string surfaceKeys");
    }
    let node = root;
    for (const key of record.surfaceKeys) {
      if (!node.children.has(key)) node.children.set(key, { children: new Map(), record: null, length: node.length + 1 });
      node = node.children.get(key);
    }
    // Keep the first record on exact duplicate phrases, matching the former
    // input-order tie break without comparing every saved phrase per token.
    if (!node.record) node.record = record;
  });

  const matches = [];
  let startIndex = 0;
  while (startIndex < tokenKeys.length) {
    let best = null;
    let node = root;
    for (let offset = 0; offset < 12 && startIndex + offset < tokenKeys.length; offset += 1) {
      node = node.children.get(tokenKeys[startIndex + offset]);
      if (!node) break;
      if (node.record) best = { record: node.record, length: node.length };
    }
    if (best) {
      matches.push({
        startIndex,
        endIndex: startIndex + best.length,
        record: best.record,
      });
      startIndex += best.length;
    } else {
      startIndex += 1;
    }
  }
  return matches;
}
