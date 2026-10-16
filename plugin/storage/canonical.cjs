/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

const HASH_PATTERNS = Object.freeze({
  "xxh64-v1": /^xxh64-v1:[a-f0-9]{16}$/i,
  "sha256-v1": /^sha256-v1:[a-f0-9]{64}$/i,
});

function codedError(code, message) {
  const error = new Error(message);
  error.name = "WalSidecarError";
  error.code = code;
  return error;
}

function canonicalJson(value) {
  return encode(value, new Set());
}

function encode(value, ancestors) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw codedError("WAL_CANONICAL_INVALID_VALUE", "Canonical JSON does not accept non-finite numbers.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw codedError("WAL_CANONICAL_INVALID_VALUE", `Canonical JSON does not accept ${typeof value} values.`);
  }
  if (ancestors.has(value)) throw codedError("WAL_CANONICAL_CYCLE", "Canonical JSON cannot encode cyclic data.");

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    throw codedError("WAL_CANONICAL_INVALID_OBJECT", "Canonical JSON accepts only plain objects and arrays.");
  }
  if (Object.getOwnPropertySymbols(value).length) {
    throw codedError("WAL_CANONICAL_INVALID_OBJECT", "Canonical JSON does not accept symbol properties.");
  }

  ancestors.add(value);
  try {
    if (isArray) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) {
          throw codedError("WAL_CANONICAL_INVALID_ARRAY", "Canonical JSON does not accept sparse arrays or array accessors.");
        }
        result.push(encode(descriptor.value, ancestors));
      }
      for (const key of Object.keys(descriptors)) {
        if (key === "length") continue;
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
          throw codedError("WAL_CANONICAL_INVALID_ARRAY", "Canonical JSON does not accept extra array properties.");
        }
      }
      return `[${result.join(",")}]`;
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    // Match JSON's enumerable own-property model. Verified stores attach
    // non-enumerable replay views which must never change canonical bytes.
    const keys = Object.keys(descriptors).filter((key) => descriptors[key].enumerable).sort();
    const fields = [];
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!("value" in descriptor)) {
        throw codedError("WAL_CANONICAL_INVALID_OBJECT", "Canonical JSON does not accept object accessors.");
      }
      fields.push(`${JSON.stringify(key)}:${encode(descriptor.value, ancestors)}`);
    }
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function unsignedValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("WAL_INTEGRITY_INVALID", "A sidecar integrity envelope must be an object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw codedError("WAL_INTEGRITY_INVALID", "A sidecar integrity envelope must be a plain object.");
  }
  if (Object.getOwnPropertySymbols(value).length) {
    throw codedError("WAL_INTEGRITY_INVALID", "A sidecar integrity envelope cannot contain symbol properties.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = {};
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!("value" in descriptor)) {
      throw codedError("WAL_INTEGRITY_INVALID", "A sidecar integrity envelope cannot contain accessors.");
    }
    if (key === "integrity") continue;
    Object.defineProperty(result, key, {
      value: descriptor.value, enumerable: true, writable: true, configurable: true,
    });
  }
  return result;
}

function utf8(text) {
  if (typeof TextEncoder !== "function") {
    throw codedError("WAL_INTEGRITY_UNAVAILABLE", "TextEncoder is required to hash a sidecar in this runtime.");
  }
  return new TextEncoder().encode(text);
}

function validateTaggedHash(value) {
  if (typeof value !== "string") return false;
  return Object.values(HASH_PATTERNS).some((pattern) => pattern.test(value));
}

async function digest(value, hash) {
  if (typeof hash !== "function") throw codedError("WAL_INTEGRITY_UNAVAILABLE", "An injected hash function is required.");
  const result = await hash(utf8(canonicalJson(value)));
  if (!validateTaggedHash(result)) {
    throw codedError("WAL_INTEGRITY_INVALID_HASH", "The injected hash function returned an unsupported or incomplete hash.");
  }
  return result.toLowerCase();
}

async function seal(value, hash) {
  const unsigned = unsignedValue(value);
  const integrity = await digest(unsigned, hash);
  return { ...unsigned, integrity };
}

async function verify(value, hash) {
  const unsigned = unsignedValue(value);
  const expected = value.integrity;
  if (!validateTaggedHash(expected)) {
    throw codedError("WAL_INTEGRITY_INVALID", "The sidecar integrity hash is missing or has an unsupported format.");
  }
  const actual = await digest(unsigned, hash);
  if (actual !== expected.toLowerCase()) {
    throw codedError("WAL_INTEGRITY_MISMATCH", "The sidecar integrity hash does not match its contents.");
  }
  return unsigned;
}

module.exports = {
  canonicalJson,
  seal,
  verify,
  // These aliases keep call sites self-documenting without multiplying logic.
  sealSidecar: seal,
  verifySidecar: verify,
};
