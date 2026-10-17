import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const { DEVICE_ID_KEY, localVocabularyDeviceId } = require("../plugin/vocabulary/device-identity.cjs");

function storage(seed = []) {
  const values = new Map(seed);
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test("Vocabulary device identity is installation-local and survives new sessions", () => {
  const local = storage();
  const first = localVocabularyDeviceId({ storage: local, crypto: { randomUUID: () => "local-device-one" } });
  assert.equal(first, "local-device-one");
  assert.equal(local.values.get(DEVICE_ID_KEY), first);
  assert.equal(localVocabularyDeviceId({ storage: local, crypto: { randomUUID() { throw Error("must not regenerate"); } } }), first);
  assert.equal(localVocabularyDeviceId({ storage: storage(), crypto: { randomUUID: () => "other-device-two" } }), "other-device-two");
});

test("unavailable, corrupted or unverified device identity never silently falls back to a session ID", () => {
  const errorCode = { code: "vocabulary-device-identity-unavailable" };
  assert.throws(() => localVocabularyDeviceId({ storage: null }), errorCode);
  assert.throws(() => localVocabularyDeviceId({ storage: storage([[DEVICE_ID_KEY, "bad"]]) }), errorCode);
  assert.throws(() => localVocabularyDeviceId({ storage: storage(), crypto: {} }), errorCode);
  assert.throws(() => localVocabularyDeviceId({ storage: { getItem: () => null, setItem() {} }, crypto: { randomUUID: () => "valid-local-id" } }), errorCode);
  assert.throws(() => localVocabularyDeviceId({ storage: { getItem() { throw Error("denied"); }, setItem() {} } }), errorCode);
});
