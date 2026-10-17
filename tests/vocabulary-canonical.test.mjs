import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { canonicalStringify, hashText, sha256Text, canonicalHash } = require("../plugin/vocabulary/canonical.cjs");

test("canonical vocabulary JSON sorts object keys recursively and preserves array order", () => {
  assert.equal(canonicalStringify({ z: 1, a: { y: 2, x: 3 }, list: [3, 1] }),
    '{"a":{"x":3,"y":2},"list":[3,1],"z":1}');
  assert.equal(canonicalHash({ z: 1, a: 2 }), canonicalHash({ a: 2, z: 1 }));
  assert.notEqual(canonicalHash([1, 2]), canonicalHash([2, 1]));
});

test("pure JavaScript SHA-256 matches standard empty, ASCII, and multiblock vectors", () => {
  assert.equal(sha256Text(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Text("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Text("a".repeat(1000)), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
  assert.equal(hashText("abc"), `sha256-v1:${sha256Text("abc")}`);
  assert.match(canonicalHash({ word: "naïve" }), /^sha256-v1:[a-f0-9]{64}$/);
});

test("canonicalization rejects values with ambiguous or executable JSON meaning", () => {
  const cycle = {};
  cycle.self = cycle;
  const sparse = [];
  sparse.length = 1;
  const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { throw new Error("must not run"); } });
  for (const value of [undefined, () => {}, 1n, NaN, Infinity, new Date(), cycle, sparse, accessor]) {
    assert.throws(() => canonicalStringify(value));
  }
  const symbolKey = { value: 1 };
  symbolKey[Symbol("hidden")] = 2;
  assert.throws(() => canonicalStringify(symbolKey));
  const extraArray = [1];
  extraArray.label = "not-json";
  assert.throws(() => canonicalStringify(extraArray));
});
