import { normalizeTermKey } from "./english-normalizer.js";

const LETTER = /\p{L}/u;
const MARK = /\p{M}/u;
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
const APOSTROPHE = /['\u2018\u2019\u02BC\uFF07]/u;
const LINE_HYPHEN = /[-\u2010]/u;
const LINE_BREAK = /^[\r\n\u2028\u2029]$/u;
const HORIZONTAL_WHITESPACE = /^[\t \f\v\u00a0]$/u;
const ASCII_DIGIT = /^[0-9]$/u;
const MAX_PAGE_TEXT_UNITS = 50000;
const MAX_LINE_HYPHEN_EVIDENCE = 64;
const MAX_LINE_HYPHEN_SEGMENT_INDEX = 255;

function isLetter(character) {
  return LETTER.test(character);
}

function isMark(character) {
  return MARK.test(character);
}

function isWordChar(character) {
  return WORD_CHAR.test(character);
}

function hasTextLayerSkipMarker(element) {
  if (element?.nodeType !== 1) return false;

  const tagName = String(element.tagName || "").toLowerCase();
  if (tagName === "script" || tagName === "style") return true;
  if (element.getAttribute?.("aria-hidden") === "true") return true;

  const className = element.className?.baseVal ?? element.className ?? "";
  return /(?:^|\s)endOfContent(?:\s|$)/u.test(String(className));
}

function* textNodesIn(root) {
  if (!root) return;
  if (root.nodeType === 3) {
    yield root;
    return;
  }

  for (const child of Array.from(root.childNodes || [])) {
    if (hasTextLayerSkipMarker(child)) continue;
    yield* textNodesIn(child);
  }
}

function collectUnits(root) {
  const units = [];
  let totalCodeUnits = 0;
  for (const node of textNodesIn(root)) {
    const source = typeof node.nodeValue === "string"
      ? node.nodeValue
      : typeof node.data === "string"
        ? node.data
        : "";
    totalCodeUnits += source.length;
    if (totalCodeUnits > MAX_PAGE_TEXT_UNITS) {
      const error = new RangeError("PDF text layer exceeds the vocabulary scan limit.");
      error.code = "page-text-limit";
      throw error;
    }
    for (let startOffset = 0; startOffset < source.length;) {
      const codePoint = source.codePointAt(startOffset);
      const character = String.fromCodePoint(codePoint);
      const endOffset = startOffset + character.length;
      units.push({ node, character, startOffset, endOffset });
      startOffset = endOffset;
    }
  }
  return units;
}

function readWordEnd(units, start, root) {
  let index = start;
  let hasLetter = false;

  while (index < units.length) {
    const character = units[index].character;
    if (isWordChar(character)) {
      const previous = units[index - 1];
      if (
        index > start &&
        previous &&
        isWordChar(previous.character) &&
        isGeometricWordBoundary(previous, units[index], root)
      ) {
        break;
      }
      hasLetter ||= isLetter(character);
      index += 1;
      continue;
    }

    // Keep an apostrophe only when it is internal to an alphabetic surface.
    // The next letter check also prevents trailing quotation marks from
    // leaking into a vocabulary token.
    if (
      APOSTROPHE.test(character) &&
      hasLetter &&
      index + 1 < units.length &&
      isLetter(units[index + 1].character)
    ) {
      if (isGeometricWordBoundary(units[index], units[index + 1], root)) break;
      index += 1;
      continue;
    }
    break;
  }

  return { end: index, hasLetter };
}

function rangeForUnit(unit, root) {
  const document = root?.ownerDocument || unit.node?.ownerDocument;
  if (typeof document?.createRange !== "function") return null;

  let range;
  try {
    range = document.createRange();
    range.setStart(unit.node, unit.startOffset);
    range.setEnd(unit.node, unit.endOffset);
    const rect = range.getBoundingClientRect?.();
    if (!rect) return null;
    const top = Number(rect.top);
    const left = Number(rect.left);
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (![top, left, width, height].every(Number.isFinite) || height <= 0) {
      return null;
    }
    return { top, left, width, height };
  } catch {
    return null;
  } finally {
    range?.detach?.();
  }
}

function isGeometricWordBoundary(previous, next, root) {
  if (!previous || !next || previous.node === next.node) return false;

  const previousRect = rangeForUnit(previous, root);
  const nextRect = rangeForUnit(next, root);
  // If a DOM boundary cannot be measured, split conservatively. Joining would
  // manufacture a surface that is not present in the text layer.
  if (!previousRect || !nextRect) return true;

  const lineHeight = Math.max(previousRect.height, nextRect.height);
  const previousCenterY = previousRect.top + previousRect.height / 2;
  const nextCenterY = nextRect.top + nextRect.height / 2;
  const sameLineTolerance = Math.min(previousRect.height, nextRect.height) * 0.4;
  if (Math.abs(nextCenterY - previousCenterY) > sameLineTolerance) return true;

  const horizontalGap = nextRect.left - (previousRect.left + previousRect.width);
  const referenceGlyphWidth = Math.max(0, Math.min(previousRect.width, nextRect.width));
  const wordGapThreshold = Math.max(
    Number.EPSILON,
    lineHeight * 0.12,
    referenceGlyphWidth * 0.3,
  );
  return horizontalGap > wordGapThreshold;
}

function isConfirmedLineEndHyphen(hyphen, continuation, root) {
  const hyphenRect = rangeForUnit(hyphen, root);
  const continuationRect = rangeForUnit(continuation, root);
  if (!hyphenRect || !continuationRect) return false;

  // A geometric line transition is required. If layout cannot prove it, keep
  // the two surfaces separate instead of guessing from punctuation alone.
  const lineHeight = Math.max(hyphenRect.height, continuationRect.height);
  const verticalDelta = continuationRect.top - hyphenRect.top;
  const minimumDelta = Math.max(2, Math.min(hyphenRect.height, continuationRect.height) * 0.4);
  const maximumDelta = Math.max(8, lineHeight * 2.25);
  const startsAtPreviousLine = continuationRect.left <= hyphenRect.left + Math.max(3, lineHeight * 0.75);
  return verticalDelta >= minimumDelta && verticalDelta <= maximumDelta && startsAtPreviousLine;
}

function lineHyphenContinuationIndex(units, hyphenIndex) {
  let index = hyphenIndex + 1;
  let crossedTextLine = false;
  while (index < units.length) {
    const character = units[index].character;
    if (LINE_BREAK.test(character)) {
      crossedTextLine = true;
      index += 1;
      continue;
    }
    if (HORIZONTAL_WHITESPACE.test(character)) {
      index += 1;
      continue;
    }
    break;
  }

  // A normal PDF.js TextNode boundary has no explicit newline and continues
  // to use the adjacent character. Whitespace is only skipped when it
  // contains a real text-line separator; ordinary spaced hyphenation must
  // never be stitched by this fallback.
  if (index === hyphenIndex + 1) return index;
  return crossedTextLine ? index : -1;
}

function appendUnit(units, target, index) {
  const unit = units[index];
  target.push(unit);
  return index + 1;
}

function collectSegments(consumedUnits) {
  const segments = [];
  for (const unit of consumedUnits) {
    const last = segments[segments.length - 1];
    if (last && last.textNode === unit.node && last.endOffset === unit.startOffset) {
      last.endOffset = unit.endOffset;
    } else {
      segments.push({
        textNode: unit.node,
        startOffset: unit.startOffset,
        endOffset: unit.endOffset,
      });
    }
  }
  return segments;
}

function segmentIndexForUnit(segments, unit) {
  return segments.findIndex((segment) => segment.textNode === unit.node &&
    unit.startOffset >= segment.startOffset && unit.endOffset <= segment.endOffset);
}

function makeLineHyphenEvidence(wraps, segments) {
  if (wraps.length > MAX_LINE_HYPHEN_EVIDENCE) {
    const error = new RangeError("A PDF token exceeds the line-hyphen evidence limit.");
    error.code = "line-hyphen-evidence-limit";
    throw error;
  }
  const evidence = wraps.map(({ offset, before, hyphen, after }) => ({
    offset,
    left: {
      segmentIndex: segmentIndexForUnit(segments, before),
      sourceOffset: before.startOffset,
      text: before.character,
    },
    hyphen: {
      segmentIndex: segmentIndexForUnit(segments, hyphen),
      sourceOffset: hyphen.startOffset,
      text: hyphen.character,
    },
    right: {
      segmentIndex: segmentIndexForUnit(segments, after),
      sourceOffset: after.startOffset,
      text: after.character,
    },
  }));
  const valid = evidence.every(({ left, hyphen, right }) =>
    [left, hyphen, right].every((endpoint) =>
      Number.isSafeInteger(endpoint.segmentIndex) && endpoint.segmentIndex >= 0 &&
      endpoint.segmentIndex <= MAX_LINE_HYPHEN_SEGMENT_INDEX &&
      Number.isSafeInteger(endpoint.sourceOffset) && endpoint.sourceOffset >= 0 &&
      endpoint.sourceOffset <= MAX_PAGE_TEXT_UNITS,
    ),
  );
  if (!valid) {
    const error = new RangeError("A PDF token exceeds the line-hyphen evidence bounds.");
    error.code = "line-hyphen-evidence-limit";
    throw error;
  }
  return evidence;
}

function makeToken(index, consumedUnits, logicalSurface, rawSurface = consumedUnits.map((unit) => unit.character).join(""), lineHyphenEvidence = [], segments = collectSegments(consumedUnits)) {
  const surfaceKey = normalizeTermKey(logicalSurface);
  if (!surfaceKey) return null;
  return {
    index,
    rawSurface,
    logicalSurface,
    lineHyphenEvidence,
    surfaceKey,
    segments,
  };
}

/**
 * Scan a rendered PDF.js text layer without changing it.
 *
 * Returned segment offsets are zero-based UTF-16 TextNode offsets with an
 * exclusive end, so they always refer to the physical DOM text (including
 * ligatures and any visible line-end hyphen). A line-end hyphen is omitted
 * only from the logical lookup surface when adjacent character geometry
 * confirms that the following alphabetic text begins on the next line.
 */
export function scanPageTextLayer(textLayer) {
  const units = collectUnits(textLayer);
  const tokens = [];
  let index = 0;

  while (index < units.length) {
    if (!isLetter(units[index].character) && !ASCII_DIGIT.test(units[index].character)) {
      index += 1;
      continue;
    }

    const start = index;
    const consumedUnits = [];
    const logicalParts = [];
    const rawParts = [];
    const wraps = [];
    let rawLength = 0;
    let word = readWordEnd(units, index, textLayer);
    if (!word.hasLetter) {
      index = word.end > index ? word.end : index + 1;
      continue;
    }

    while (true) {
      for (let cursor = index; cursor < word.end; cursor += 1) {
        appendUnit(units, consumedUnits, cursor);
      }
      const wordSurface = units.slice(index, word.end).map((unit) => unit.character).join("");
      logicalParts.push(wordSurface);
      rawParts.push(wordSurface);
      rawLength += wordSurface.length;
      index = word.end;

      const hyphen = units[index];
      const continuationIndex = lineHyphenContinuationIndex(units, index);
      const continuation = continuationIndex >= 0 ? units[continuationIndex] : null;
      const previous = units[index - 1];
      if (
        !hyphen ||
        !continuation ||
        !previous ||
        !LINE_HYPHEN.test(hyphen.character) ||
        !(isLetter(previous.character) || isMark(previous.character)) ||
        !isLetter(continuation.character) ||
        !isConfirmedLineEndHyphen(hyphen, continuation, textLayer)
      ) {
        break;
      }

      appendUnit(units, consumedUnits, index);
      wraps.push({
        offset: rawLength,
        before: previous,
        hyphen,
        after: continuation,
      });
      rawParts.push(hyphen.character);
      rawLength += hyphen.character.length;
      for (let separatorIndex = index + 1; separatorIndex < continuationIndex; separatorIndex += 1) {
        appendUnit(units, consumedUnits, separatorIndex);
      }
      index = continuationIndex;
      word = readWordEnd(units, index, textLayer);
      if (!word.hasLetter || word.end === index) break;
    }

    // The source is DOM-owned; its line-end hyphen remains in rawSurface and
    // segment offsets, while only the logical key drops that line-break mark.
    const logicalSurface = logicalParts.join("");
    const segments = collectSegments(consumedUnits);
    const lineHyphenEvidence = makeLineHyphenEvidence(wraps, segments);
    const token = makeToken(tokens.length, consumedUnits, logicalSurface, rawParts.join(""), lineHyphenEvidence, segments);
    if (token) tokens.push(token);

    // A defensive progress guard for malformed/fake DOM text inputs.
    if (index <= start) index = start + 1;
  }

  return tokens;
}
