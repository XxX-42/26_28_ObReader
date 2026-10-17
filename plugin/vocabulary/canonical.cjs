"use strict";

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function canonicalStringify(value) {
  return encode(value, new Set(), 0);
}

function encode(value, ancestors, depth) {
  if (depth > 128) throw codedError("VOCAB_CANONICAL_DEPTH", "Canonical vocabulary data is nested too deeply.");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw codedError("VOCAB_CANONICAL_VALUE", "Canonical data does not accept non-finite numbers.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw codedError("VOCAB_CANONICAL_VALUE", `Canonical data does not accept ${typeof value} values.`);
  }
  if (ancestors.has(value)) throw codedError("VOCAB_CANONICAL_CYCLE", "Canonical data cannot contain cycles.");
  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    throw codedError("VOCAB_CANONICAL_OBJECT", "Canonical data accepts only plain objects and arrays.");
  }
  if (Object.getOwnPropertySymbols(value).length) {
    throw codedError("VOCAB_CANONICAL_OBJECT", "Canonical data does not accept symbol properties.");
  }

  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const descriptor of Object.values(descriptors)) {
      if (!("value" in descriptor)) {
        throw codedError("VOCAB_CANONICAL_ACCESSOR", "Canonical data does not accept accessors.");
      }
    }
    if (isArray) {
      const fields = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) throw codedError("VOCAB_CANONICAL_ARRAY", "Canonical data does not accept sparse arrays.");
        fields.push(encode(descriptor.value, ancestors, depth + 1));
      }
      for (const key of Object.keys(descriptors)) {
        if (key === "length") continue;
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
          throw codedError("VOCAB_CANONICAL_ARRAY", "Canonical arrays cannot have extra properties.");
        }
      }
      return `[${fields.join(",")}]`;
    }

    const keys = Object.keys(descriptors).filter((key) => descriptors[key].enumerable).sort();
    const fields = keys.map((key) =>
      `${JSON.stringify(key)}:${encode(descriptors[key].value, ancestors, depth + 1)}`,
    );
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function sha256Text(text) {
  if (typeof text !== "string") throw new TypeError("SHA-256 input must be a string.");
  if (typeof TextEncoder !== "function") {
    throw codedError("VOCAB_HASH_UNAVAILABLE", "TextEncoder is required to hash vocabulary data.");
  }
  const input = new TextEncoder().encode(text);
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  const rotateRight = (value, amount) => (value >>> amount) | (value << (32 - amount));

  for (let blockOffset = 0; blockOffset < paddedLength; blockOffset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(blockOffset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15];
      const y = words[index - 2];
      const smallSigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const smallSigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16] + smallSigma0 + words[index - 7] + smallSigma1) >>> 0;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + bigSigma1 + choice + SHA256_K[index] + words[index]) >>> 0;
      const bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, "0")).join("");
}

function canonicalHash(value) {
  return hashText(canonicalStringify(value));
}

function hashText(text) {
  return `sha256-v1:${sha256Text(text)}`;
}

function codedError(code, message) {
  const error = new Error(message);
  error.name = "VocabularyCanonicalError";
  error.code = code;
  return error;
}

module.exports = { canonicalStringify, sha256Text, hashText, canonicalHash };
