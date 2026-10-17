import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isAmbiguousEnglishSurface,
  normalizeEnglishLemmaKey,
  normalizeTermKey,
} from "../viewer-adapter/vocabulary/english-normalizer.js";
import { scanPageTextLayer } from "../viewer-adapter/vocabulary/page-scanner.js";

function makeDocument(rectForCharacter = () => null) {
  return {
    createRange() {
      let node = null;
      let offset = 0;
      return {
        setStart(nextNode, nextOffset) {
          node = nextNode;
          offset = nextOffset;
        },
        setEnd() {},
        getBoundingClientRect() {
          return rectForCharacter(node, offset);
        },
        detach() {},
      };
    },
  };
}

function makeText(value, ownerDocument, id = "") {
  return {
    nodeType: 3,
    nodeName: "#text",
    nodeValue: value,
    ownerDocument,
    id,
    parentNode: null,
  };
}

function makeElement(children, ownerDocument, { className = "", tagName = "SPAN", ariaHidden = null } = {}) {
  const element = {
    nodeType: 1,
    tagName,
    className,
    childNodes: children,
    ownerDocument,
    parentNode: null,
    getAttribute(name) {
      return name === "aria-hidden" ? ariaHidden : null;
    },
  };
  for (const child of children) child.parentNode = element;
  return element;
}

function makeLayer(texts, ownerDocument) {
  return makeElement(texts, ownerDocument, { className: "textLayer", tagName: "DIV" });
}

function snapshot(node) {
  return {
    nodeType: node.nodeType,
    nodeValue: node.nodeValue ?? null,
    className: node.className ?? null,
    childNodes: Array.from(node.childNodes || [], snapshot),
  };
}

test("normalizes lowercase, NFC, apostrophe variants, and the common ligatures without lemmatizing", () => {
  assert.equal(normalizeTermKey("Running"), "running");
  assert.equal(normalizeTermKey("Cats"), "cats");
  assert.equal(normalizeTermKey("cafe\u0301"), "café");
  assert.equal(normalizeTermKey("Don’t"), "don't");
  assert.equal(normalizeTermKey("ﬀ ﬁ ﬂ ﬃ ﬄ"), "ff fi fl ffi ffl");
  assert.equal(normalizeTermKey("  re-enter\tagain  "), "re-enter again");
  assert.equal(normalizeTermKey(null), "");
  assert.equal(normalizeTermKey("bonjour 世界"), "");
  assert.equal(normalizeTermKey("'hello"), "");
  assert.equal(normalizeTermKey("well--being"), "");
});

test("English lemma matching conforms to shared inflection vectors without changing stored keys", () => {
  const vectors = JSON.parse(readFileSync(new URL("./fixtures/english-inflection-equivalence.json", import.meta.url), "utf8"));
  for (const group of [...vectors.equivalentWords, ...vectors.equivalentPhrases]) {
    const lemmaKeys = group.map((surface) => normalizeEnglishLemmaKey(surface));
    assert.ok(lemmaKeys.every((key) => key === lemmaKeys[0]), `${group.join(" / ")} should share one matching key`);
  }
  for (const [left, right] of [...vectors.distinctWords, ...vectors.distinctPhrases]) {
    assert.notEqual(normalizeEnglishLemmaKey(left), normalizeEnglishLemmaKey(right), `${left} must remain distinct from ${right}`);
  }
  assert.equal(normalizeTermKey("Walked"), "walked", "the persistent surface key is not rewritten to a lemma");
  assert.equal(normalizeEnglishLemmaKey("WALKING"), normalizeEnglishLemmaKey("walk"), "capitalization is ignored for matching");
  assert.equal(isAmbiguousEnglishSurface("lay"), true);
  assert.equal(isAmbiguousEnglishSurface("lie"), false);
  assert.deepEqual(["lays", "laid", "laying"].map(normalizeEnglishLemmaKey), ["lay", "lay", "lay"]);
  assert.equal(normalizeEnglishLemmaKey("series"), "series", "citation forms that only look inflected stay intact");
  assert.equal(normalizeEnglishLemmaKey("business"), "business");
  assert.equal(normalizeEnglishLemmaKey("buses"), "bus");
  assert.equal(normalizeEnglishLemmaKey("cases"), "case");
  assert.equal(normalizeEnglishLemmaKey("quizzes"), "quiz");
  assert.equal(normalizeEnglishLemmaKey("potatoes"), "potato");
  assert.equal(normalizeEnglishLemmaKey("sizes"), "size");
  assert.equal(normalizeEnglishLemmaKey("freezes"), "freeze");
  assert.equal(normalizeEnglishLemmaKey("universe"), "universe", "suffix handling does not stem an unrelated word");
});

test("accepts common imported dictionary notation without dropping the stored term", () => {
  assert.equal(normalizeTermKey("a.m."), "a.m.");
  assert.equal(normalizeTermKey("aim at/for sth"), "aim at/for sth");
  assert.equal(normalizeTermKey("associate… with…"), "associate… with…");
  assert.equal(normalizeTermKey("warn (sb) of sth"), "warn sb of sth");
  assert.equal(normalizeTermKey("bright- coloured"), "bright coloured");
});

test("scans ordinary ASCII words as lowercase surface keys without changing their forms", () => {
  const document = makeDocument();
  const source = makeText("The quick brown fox jumped.", document);
  const layer = makeLayer([source], document);

  const tokens = scanPageTextLayer(layer);
  assert.deepEqual(tokens.map((token) => token.surfaceKey), ["the", "quick", "brown", "fox", "jumped"]);
  assert.deepEqual(tokens.map((token) => token.rawSurface), ["The", "quick", "brown", "fox", "jumped"]);
  assert.deepEqual(tokens.map((token) => token.index), [0, 1, 2, 3, 4]);
});

test("drops unsupported scripts rather than creating non-English lookup keys", () => {
  const document = makeDocument();
  const source = makeText("hello Καλημέρα world", document);
  const layer = makeLayer([source], document);

  assert.deepEqual(scanPageTextLayer(layer).map((token) => token.surfaceKey), ["hello", "world"]);
});

test("keeps internal apostrophes canonical and leaves ordinary hyphen-separated pieces unstitched", () => {
  const document = makeDocument();
  const source = makeText("Don’t stop: co-operate, re-enter.", document);
  const layer = makeLayer([source], document);

  const tokens = scanPageTextLayer(layer);
  assert.deepEqual(tokens.map((token) => token.surfaceKey), [
    "don't", "stop", "co", "operate", "re", "enter",
  ]);
  assert.equal(tokens[0].rawSurface, "Don’t");
});

test("keeps ligature text and its physical UTF-16 offsets unchanged", () => {
  const document = makeDocument();
  const source = makeText("oﬃce", document);
  const layer = makeLayer([source], document);
  const before = snapshot(layer);

  const [token] = scanPageTextLayer(layer);
  assert.equal(token.rawSurface, "oﬃce");
  assert.equal(token.surfaceKey, "office");
  assert.deepEqual(token.segments, [{ textNode: source, startOffset: 0, endOffset: 4 }]);
  assert.deepEqual(snapshot(layer), before);
});

test("a word can cross spans while each segment retains its original TextNode offsets", () => {
  const rects = new Map();
  const document = makeDocument((node, offset) => rects.get(`${node.id}:${offset}`) || null);
  const first = makeText("inter", document, "first");
  const second = makeText("national", document, "second");
  rects.set("first:4", { top: 10, left: 16, width: 4, height: 12 });
  rects.set("second:0", { top: 10, left: 20, width: 4, height: 12 });
  const layer = makeLayer([
    makeElement([first], document),
    makeElement([second], document),
  ], document);

  const [token] = scanPageTextLayer(layer);
  assert.equal(token.rawSurface, "international");
  assert.equal(token.surfaceKey, "international");
  assert.deepEqual(token.segments, [
    { textNode: first, startOffset: 0, endOffset: 5 },
    { textNode: second, startOffset: 0, endOffset: 8 },
  ]);
});

test("infers a word boundary between adjacent TextNodes from rendered glyph spacing", () => {
  const rects = new Map();
  const document = makeDocument((node, offset) => rects.get(`${node.id}:${offset}`) || null);
  const first = makeText("of", document, "before-space");
  const second = makeText("that", document, "after-space");
  rects.set("before-space:1", { top: 10, left: 18, width: 4, height: 12 });
  rects.set("after-space:0", { top: 10, left: 24, width: 4, height: 12 });
  const layer = makeLayer([
    makeElement([first], document),
    makeElement([second], document),
  ], document);

  const tokens = scanPageTextLayer(layer);
  assert.deepEqual(tokens.map((token) => token.surfaceKey), ["of", "that"]);
  assert.deepEqual(tokens.map((token) => token.rawSurface), ["of", "that"]);
});

test("keeps an explicit whitespace boundary when PDF.js splits the space into its own TextNode", () => {
  const document = makeDocument();
  const first = makeText("of", document, "word");
  const whitespace = makeText(" ", document, "space");
  const second = makeText("that", document, "next-word");
  const layer = makeLayer([
    makeElement([first], document),
    makeElement([whitespace], document),
    makeElement([second], document),
  ], document);

  assert.deepEqual(scanPageTextLayer(layer).map((token) => token.surfaceKey), ["of", "that"]);
});

test("keeps a word split across adjacent TextNodes when glyph geometry is continuous", () => {
  const rects = new Map();
  const document = makeDocument((node, offset) => rects.get(`${node.id}:${offset}`) || null);
  const first = makeText("eco", document, "style-a");
  const second = makeText("nomy", document, "style-b");
  rects.set("style-a:2", { top: 10, left: 18, width: 4, height: 12 });
  rects.set("style-b:0", { top: 10, left: 22, width: 4, height: 12 });
  const layer = makeLayer([
    makeElement([first], document),
    makeElement([second], document),
  ], document);

  const [token] = scanPageTextLayer(layer);
  assert.equal(token.surfaceKey, "economy");
  assert.deepEqual(token.segments, [
    { textNode: first, startOffset: 0, endOffset: 3 },
    { textNode: second, startOffset: 0, endOffset: 4 },
  ]);
});

test("does not join adjacent TextNodes across a visual line boundary", () => {
  const rects = new Map();
  const document = makeDocument((node, offset) => rects.get(`${node.id}:${offset}`) || null);
  const first = makeText("goods", document, "left-column");
  const second = makeText("exports", document, "next-line");
  rects.set("left-column:4", { top: 10, left: 50, width: 5, height: 12 });
  rects.set("next-line:0", { top: 24, left: 4, width: 4, height: 12 });
  const layer = makeLayer([
    makeElement([first], document),
    makeElement([second], document),
  ], document);

  assert.deepEqual(scanPageTextLayer(layer).map((token) => token.surfaceKey), ["goods", "exports"]);
});

test("does not join adjacent TextNodes across a wide same-line column gap", () => {
  const rects = new Map();
  const document = makeDocument((node, offset) => rects.get(`${node.id}:${offset}`) || null);
  const first = makeText("goods", document, "left-column");
  const second = makeText("exports", document, "right-column");
  rects.set("left-column:4", { top: 10, left: 50, width: 5, height: 12 });
  rects.set("right-column:0", { top: 10, left: 500, width: 4, height: 12 });
  const layer = makeLayer([
    makeElement([first], document),
    makeElement([second], document),
  ], document);

  assert.deepEqual(scanPageTextLayer(layer).map((token) => token.surfaceKey), ["goods", "exports"]);
});

test("keeps punctuation between TextNodes as a token separator", () => {
  const document = makeDocument();
  const first = makeText("goods", document, "word");
  const punctuation = makeText(",", document, "punctuation");
  const second = makeText("exports", document, "next-word");
  const layer = makeLayer([
    makeElement([first], document),
    makeElement([punctuation], document),
    makeElement([second], document),
  ], document);

  assert.deepEqual(scanPageTextLayer(layer).map((token) => token.surfaceKey), ["goods", "exports"]);
});

test("TextNode boundary tokenization is invariant under uniform page zoom", () => {
  const tokenizeAtScale = (scale) => {
    const rects = new Map();
    const document = makeDocument((node, offset) => rects.get(`${node.id}:${offset}`) || null);
    const first = makeText("of", document, "of");
    const second = makeText("that", document, "that");
    rects.set("of:1", { top: 10 * scale, left: 18 * scale, width: 4 * scale, height: 12 * scale });
    rects.set("that:0", { top: 10 * scale, left: 24 * scale, width: 4 * scale, height: 12 * scale });
    const layer = makeLayer([
      makeElement([first], document),
      makeElement([second], document),
    ], document);
    return scanPageTextLayer(layer).map((token) => token.surfaceKey);
  };

  assert.deepEqual(tokenizeAtScale(0.25), ["of", "that"]);
  assert.deepEqual(tokenizeAtScale(0.5), ["of", "that"]);
  assert.deepEqual(tokenizeAtScale(1), ["of", "that"]);
  assert.deepEqual(tokenizeAtScale(1.25), ["of", "that"]);
  assert.deepEqual(tokenizeAtScale(2), ["of", "that"]);
  assert.deepEqual(tokenizeAtScale(4), ["of", "that"]);
});

test("fails closed at an ambiguous TextNode boundary whose geometry is unavailable", () => {
  const document = makeDocument();
  const first = makeText("of", document, "unknown-a");
  const second = makeText("that", document, "unknown-b");
  const layer = makeLayer([
    makeElement([first], document),
    makeElement([second], document),
  ], document);

  assert.deepEqual(scanPageTextLayer(layer).map((token) => token.surfaceKey), ["of", "that"]);
});

test("stitches only a geometrically confirmed line-end hyphen and keeps both physical segments", () => {
  const rects = new Map();
  const document = makeDocument((node, offset) => rects.get(`${node.id}:${offset}`) || null);
  const first = makeText("inter-", document, "line-one");
  const second = makeText("national", document, "line-two");
  rects.set("line-one:5", { top: 10, left: 70, width: 5, height: 12 });
  rects.set("line-two:0", { top: 24, left: 4, width: 7, height: 12 });
  const layer = makeLayer([
    makeElement([first], document),
    makeElement([second], document),
  ], document);
  const before = snapshot(layer);

  const [token] = scanPageTextLayer(layer);
  assert.equal(token.rawSurface, "inter-national");
  assert.equal(token.surfaceKey, "international");
  assert.deepEqual(token.segments, [
    { textNode: first, startOffset: 0, endOffset: 6 },
    { textNode: second, startOffset: 0, endOffset: 8 },
  ]);
  assert.deepEqual(snapshot(layer), before);
});

test("leaves a hyphenated pair separate when line geometry cannot confirm a break", () => {
  const document = makeDocument();
  const first = makeText("inter-", document, "line-one");
  const second = makeText("national", document, "line-two");
  const layer = makeLayer([
    makeElement([first], document),
    makeElement([second], document),
  ], document);

  const tokens = scanPageTextLayer(layer);
  assert.deepEqual(tokens.map((token) => token.surfaceKey), ["inter", "national"]);
  assert.deepEqual(tokens.map((token) => token.rawSurface), ["inter", "national"]);
});

test("does not stitch when vertical offsets suggest a superscript or indented continuation", () => {
  const rects = new Map();
  const document = makeDocument((node, offset) => rects.get(`${node.id}:${offset}`) || null);
  const first = makeText("inter-", document, "line-one");
  const second = makeText("national", document, "line-two");
  rects.set("line-one:5", { top: 10, left: 70, width: 5, height: 12 });
  rects.set("line-two:0", { top: 24, left: 100, width: 7, height: 12 });
  const layer = makeLayer([
    makeElement([first], document),
    makeElement([second], document),
  ], document);

  assert.deepEqual(scanPageTextLayer(layer).map((token) => token.surfaceKey), ["inter", "national"]);
});

test("never reads hidden text-layer sentinels into vocabulary and does not mutate the layer", () => {
  const document = makeDocument();
  const visible = makeText("visible text", document);
  const hidden = makeText("not a word", document);
  const layer = makeLayer([
    makeElement([visible], document),
    makeElement([hidden], document, { className: "endOfContent" }),
  ], document);
  const before = snapshot(layer);

  assert.deepEqual(scanPageTextLayer(layer).map((token) => token.surfaceKey), ["visible", "text"]);
  assert.deepEqual(snapshot(layer), before);
});

test("rejects pathological text layers above the explicit scan budget", () => {
  const document = makeDocument();
  const layer = makeLayer([makeText("a ".repeat(25001), document)], document);
  assert.throws(() => scanPageTextLayer(layer), (error) => error.code === "page-text-limit");
});
