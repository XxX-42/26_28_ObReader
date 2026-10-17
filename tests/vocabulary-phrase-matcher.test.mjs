import test from "node:test";
import assert from "node:assert/strict";
import {
  getSelectedPageTokens,
  matchPhrases,
  VocabularySelectionError,
} from "../viewer-adapter/vocabulary/phrase-matcher.js";

import { readFileSync } from "node:fs";

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

test("phrase matching conforms to shared token-by-token English inflection vectors", () => {
  const vectors = JSON.parse(readFileSync(new URL("./fixtures/english-inflection-equivalence.json", import.meta.url), "utf8"));
  for (const group of vectors.equivalentPhrases) {
    const record = { key: group[0], storageKey: group[0], surfaceKeys: group[0].split(" ") };
    for (const surface of group) {
      const tokens = surface.split(" ").map((surfaceKey, index) => ({ surfaceKey, index }));
      assert.deepEqual(matchPhrases(tokens, [record]), [
        { startIndex: 0, endIndex: tokens.length, record },
      ], `${surface} should match ${group[0]} token-by-token`);
    }
  }

  for (const [recordPhrase, differentPhrase] of vectors.distinctPhrases) {
    const record = { key: recordPhrase, storageKey: recordPhrase, surfaceKeys: recordPhrase.split(" ") };
    const tokens = differentPhrase.split(" ").map((surfaceKey, index) => ({ surfaceKey, index }));
    assert.deepEqual(matchPhrases(tokens, [record]), [], `${differentPhrase} must not match ${recordPhrase}`);
  }
});

test("exact queried phrase wins over inflection aliases and ambiguous lie/lay fallback stays conservative", () => {
  const exactInflected = {
    key: "walked the dog", storageKey: "walk the dog", surfaceKeys: ["walked", "the", "dog"],
  };
  const canonicalPhrase = {
    key: "walk the dog", storageKey: "walk the dog", surfaceKeys: ["walk", "the", "dog"],
  };
  const inflectedTokens = ["walked", "the", "dog"].map((surfaceKey, index) => ({ surfaceKey, index }));
  assert.equal(matchPhrases(inflectedTokens, [canonicalPhrase, exactInflected])[0].record, exactInflected);

  const lie = { key: "lie down", storageKey: "lie down", surfaceKeys: ["lie", "down"] };
  const lay = { key: "lay down", storageKey: "lay down", surfaceKeys: ["lay", "down"] };
  const layTokens = ["lay", "down"].map((surfaceKey, index) => ({ surfaceKey, index }));
  assert.equal(matchPhrases(layTokens, [lie, lay])[0].record, lay, "an exact lay phrase wins over the lie past tense alias");

  const lainTokens = ["lain", "down"].map((surfaceKey, index) => ({ surfaceKey, index }));
  assert.equal(matchPhrases(lainTokens, [lie, lay])[0].record, lie, "the explicit lain form resolves to lie");
  assert.equal(matchPhrases(layTokens, [lie])[0].record, lie, "when no exact lay record exists, the unique lie alias remains usable");
  const laidTokens = ["laid", "down"].map((surfaceKey, index) => ({ surfaceKey, index }));
  assert.equal(matchPhrases(laidTokens, [lie, lay])[0].record, lay, "laid follows the distinct lay verb family");
});

test("phrase matcher keeps case-insensitive exact records and deterministic ties", () => {
  const tokens = [
    { surfaceKey: "Run", index: 0 },
    { surfaceKey: "runs", index: 1 },
  ];
  const firstTie = { id: "first", surfaceKeys: ["RUN", "run"] };
  const secondTie = { id: "second", surfaceKeys: ["run", "runs"] };
  assert.equal(matchPhrases(tokens, [firstTie, secondTie])[0].record, secondTie,
    "an exact normalized surface wins over an inflection alias even when it appears later");
});

test("phrase records require two through twelve surface keys", () => {
  assert.throws(() => matchPhrases([], [{ surfaceKeys: ["one"] }]), /2–12/);
  assert.throws(() => matchPhrases([], [{ surfaceKeys: Array(13).fill("one") }]), /2–12/);
});
