import test from "node:test";
import assert from "node:assert/strict";
import {
  getSelectedPageTokens,
  matchPhrases,
  VocabularySelectionError,
} from "../viewer-adapter/vocabulary/phrase-matcher.js";

function makePage() {
  return {
    children: [],
    contains(node) {
      if (node === this) return true;
      for (let current = node?.parentNode; current; current = current.parentNode) {
        if (current === this) return true;
      }
      return false;
    },
  };
}

function makeTextNode(page, data) {
  const node = { nodeType: 3, data, length: data.length, parentNode: page };
  page.children.push(node);
  return node;
}

function pageToken(surfaceKey, textNode, startOffset, endOffset, index = 0) {
  return {
    index,
    rawSurface: surfaceNodeText(textNode, startOffset, endOffset),
    surfaceKey,
    segments: [{ textNode, startOffset, endOffset }],
  };
}

function surfaceNodeText(node, start, end) {
  return node.data.slice(start, end);
}

function fakeRange(page, startContainer, startOffset, endContainer, endOffset) {
  return {
    startContainer,
    startOffset,
    endContainer,
    endOffset,
    collapsed: startContainer === endContainer && startOffset === endOffset,
    commonAncestorContainer: page,
    intersectsNode(node) {
      const order = page.children;
      const startIndex = order.indexOf(startContainer);
      const endIndex = order.indexOf(endContainer);
      const nodeIndex = order.indexOf(node);
      if (nodeIndex < 0 || startIndex < 0 || endIndex < 0) return false;
      if (startIndex === endIndex) return false;
      return nodeIndex >= Math.min(startIndex, endIndex) && nodeIndex <= Math.max(startIndex, endIndex);
    },
  };
}

function assertSelectionError(fn, code, count = undefined) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof VocabularySelectionError);
    assert.equal(error.code, code);
    if (count !== undefined) assert.equal(error.selectedCount, count);
    return true;
  });
}

test("range intersection returns matching tokens in supplied page reading order", () => {
  const page = makePage();
  const text = makeTextNode(page, "alpha beta gamma");
  const alpha = pageToken("alpha", text, 0, 5, 0);
  const beta = pageToken("beta", text, 6, 10, 1);
  const gamma = pageToken("gamma", text, 11, 16, 2);
  const range = fakeRange(page, text, 3, text, 8);

  assert.deepEqual(
    getSelectedPageTokens(range, [alpha, beta, gamma], { pageRoot: page }),
    [alpha, beta],
  );
});

test("multi-node range selection uses original TextNode segments", () => {
  const page = makePage();
  const firstNode = makeTextNode(page, "one ");
  const secondNode = makeTextNode(page, "two three");
  const tokens = [
    pageToken("one", firstNode, 0, 3, 0),
    pageToken("two", secondNode, 0, 3, 1),
    pageToken("three", secondNode, 4, 9, 2),
  ];
  const range = fakeRange(page, firstNode, 1, secondNode, 3);

  assert.deepEqual(getSelectedPageTokens(range, tokens, { pageRoot: page }), tokens.slice(0, 2));
});

test("selection must stay within the requested page", () => {
  const firstPage = makePage();
  const secondPage = makePage();
  const firstText = makeTextNode(firstPage, "first");
  const secondText = makeTextNode(secondPage, "second");
  const outsideCommonAncestor = { contains: () => true };
  const range = {
    startContainer: firstText,
    startOffset: 1,
    endContainer: secondText,
    endOffset: 3,
    commonAncestorContainer: outsideCommonAncestor,
    intersectsNode: () => true,
  };

  assertSelectionError(
    () => getSelectedPageTokens(range, [pageToken("first", firstText, 0, 5)], { pageRoot: firstPage }),
    "cross-page",
  );
});

test("accepts exactly two selected tokens at the minimum", () => {
  const page = makePage();
  const text = makeTextNode(page, "abcdefghijklmnop");
  const tokens = Array.from({ length: 13 }, (_, index) => pageToken(
    String(index), text, index, index + 1, index,
  ));

  assert.equal(getSelectedPageTokens(fakeRange(page, text, 0, text, 2), tokens, { pageRoot: page }).length, 2);
});

test("accepts exactly twelve selected tokens at the maximum", () => {
  const page = makePage();
  const text = makeTextNode(page, "abcdefghijklmnop");
  const tokens = Array.from({ length: 13 }, (_, index) => pageToken(
    String(index), text, index, index + 1, index,
  ));

  assert.equal(getSelectedPageTokens(fakeRange(page, text, 0, text, 12), tokens, { pageRoot: page }).length, 12);
});

test("rejects one-token and thirteen-token selections without truncation", () => {
  const page = makePage();
  const text = makeTextNode(page, "abcdefghijklmnop");
  const tokens = Array.from({ length: 13 }, (_, index) => pageToken(
    String(index), text, index, index + 1, index,
  ));

  assertSelectionError(
    () => getSelectedPageTokens(fakeRange(page, text, 0, text, 1), tokens, { pageRoot: page }),
    "token-count",
    1,
  );
  assertSelectionError(
    () => getSelectedPageTokens(fakeRange(page, text, 0, text, 13), tokens, { pageRoot: page }),
    "token-count",
    13,
  );
});

test("overlapping phrases resolve leftmost-longest with deterministic input-order ties", () => {
  const tokens = ["a", "b", "c", "d", "e"].map((surfaceKey, index) => ({ surfaceKey, index }));
  const shorterAtLeft = { id: "ab", surfaceKeys: ["a", "b"] };
  const longerAtSameStart = { id: "abc", surfaceKeys: ["a", "b", "c"] };
  const longestAtNextStart = { id: "bcd", surfaceKeys: ["b", "c", "d"] };
  const trailing = { id: "de", surfaceKeys: ["d", "e"] };

  assert.deepEqual(
    matchPhrases(tokens, [shorterAtLeft, longestAtNextStart]),
    [{ startIndex: 0, endIndex: 2, record: shorterAtLeft }],
    "the earliest start wins over a longer phrase beginning later",
  );

  assert.deepEqual(
    matchPhrases(tokens, [shorterAtLeft, longerAtSameStart, longestAtNextStart, trailing]),
    [
      { startIndex: 0, endIndex: 3, record: longerAtSameStart },
      { startIndex: 3, endIndex: 5, record: trailing },
    ],
  );

  const firstTie = { id: "first", surfaceKeys: ["a", "b"] };
  const secondTie = { id: "second", surfaceKeys: ["a", "b"] };
  assert.equal(matchPhrases(tokens, [firstTie, secondTie])[0].record, firstTie);
});

test("phrase matches require exact surfaceKey sequences with no case-folding or lemmatization", () => {
  const tokens = [
    { surfaceKey: "Run", index: 0 },
    { surfaceKey: "runs", index: 1 },
    { surfaceKey: "fast", index: 2 },
    { surfaceKey: "today", index: 3 },
  ];
  const lowercase = { id: "lowercase", surfaceKeys: ["run", "runs"] };
  const exactFirst = { id: "exact-first", surfaceKeys: ["Run", "runs"] };
  const exactPair = { id: "exact-pair", surfaceKeys: ["runs", "fast"] };
  const lemmaLike = { id: "lemma-like", surfaceKeys: ["run", "fast"] };
  const exactLast = { id: "exact-last", surfaceKeys: ["fast", "today"] };

  assert.deepEqual(matchPhrases(tokens, [lowercase, exactFirst, exactPair, lemmaLike, exactLast]), [
    { startIndex: 0, endIndex: 2, record: exactFirst },
    { startIndex: 2, endIndex: 4, record: exactLast },
  ]);
});

test("phrase records require two through twelve surface keys", () => {
  assert.throws(() => matchPhrases([], [{ surfaceKeys: ["one"] }]), /2–12/);
  assert.throws(() => matchPhrases([], [{ surfaceKeys: Array(13).fill("one") }]), /2–12/);
});
