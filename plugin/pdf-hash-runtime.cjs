/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

const xxhash = require("xxhash-wasm");
const { sha256 } = require("@noble/hashes/sha2");

const XXH64_PREFIX = "xxh64-v1:";
const SHA256_PREFIX = "sha256-v1:";
const LEGACY_SHA256 = /^[a-f0-9]{64}$/i;
const XXH64 = /^xxh64-v1:[a-f0-9]{16}$/i;
const TAGGED_SHA256 = /^sha256-v1:[a-f0-9]{64}$/i;
const TAIL_SAMPLE_BYTES = 64 * 1024;

function bytesView(value) {
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("Invalid PDF hash input.");
}

function toHex64(value) {
  return BigInt.asUintN(64, value).toString(16).padStart(16, "0");
}

function toHex(bytes) {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function sha256Hex(value) {
  return toHex(sha256(bytesView(value)));
}

function sha256Chunks(chunks) {
  const hash = sha256.create();
  for (const chunk of chunks) hash.update(bytesView(chunk));
  return toHex(hash.digest());
}

function isSupportedHash(value) {
  return typeof value === "string" &&
    (XXH64.test(value) || TAGGED_SHA256.test(value) || LEGACY_SHA256.test(value));
}

function hashFileKey(value) {
  if (typeof value !== "string") throw new TypeError("Invalid PDF hash key.");
  return value.replace(/^xxh64-v1:/i, "xxh64-v1-").replace(/^sha256-v1:/i, "sha256-v1-");
}

async function createPdfHashRuntime({ forceSha256 = false } = {}) {
  let xxh = null;
  let fallbackReason = null;
  if (!forceSha256) {
    try {
      xxh = await xxhash();
    } catch (error) {
      fallbackReason = String(error?.message || error || "WebAssembly initialization failed").slice(0, 256);
    }
  } else {
    fallbackReason = "XXH64 disabled for fallback verification";
  }

  const algorithm = xxh ? "xxh64-v1" : "sha256-v1";
  const fingerprint = (value) => {
    const bytes = bytesView(value);
    if (!xxh) return `${SHA256_PREFIX}${sha256Hex(bytes)}`;
    const hasher = xxh.create64();
    hasher.update(bytes);
    return `${XXH64_PREFIX}${toHex64(hasher.digest())}`;
  };
  const fingerprintChunks = (chunks) => {
    if (!xxh) return `${SHA256_PREFIX}${sha256Chunks(chunks)}`;
    const hasher = xxh.create64();
    for (const chunk of chunks) hasher.update(bytesView(chunk));
    return `${XXH64_PREFIX}${toHex64(hasher.digest())}`;
  };
  const createAccumulator = (expectedHash = null) => {
    const useXxh = Boolean(xxh) && (!expectedHash || XXH64.test(expectedHash));
    const hasher = useXxh ? xxh.create64() : sha256.create();
    return {
      update(value) { hasher.update(bytesView(value)); },
      digest() {
        const digest = hasher.digest();
        if (useXxh) return `${XXH64_PREFIX}${toHex64(digest)}`;
        const hex = toHex(digest);
        return expectedHash && LEGACY_SHA256.test(expectedHash) ? hex : `${SHA256_PREFIX}${hex}`;
      },
    };
  };
  const matches = (value, expected) => {
    if (!isSupportedHash(expected)) return false;
    const bytes = bytesView(value);
    const normalizedExpected = expected.toLowerCase();
    if (XXH64.test(normalizedExpected)) {
      return Boolean(xxh) && fingerprint(bytes).toLowerCase() === normalizedExpected;
    }
    const expectedSha = normalizedExpected.startsWith(SHA256_PREFIX)
      ? normalizedExpected.slice(SHA256_PREFIX.length)
      : normalizedExpected;
    return sha256Hex(bytes) === expectedSha.toLowerCase();
  };
  const compare = (left, right) => {
    const a = bytesView(left);
    const b = bytesView(right);
    if (a.byteLength !== b.byteLength) return false;
    const sampleLength = Math.min(TAIL_SAMPLE_BYTES, a.byteLength);
    const sampleStart = a.byteLength - sampleLength;
    for (let index = sampleStart; index < a.byteLength; index += 1) {
      if (a[index] !== b[index]) return false;
    }
    return fingerprint(a).toLowerCase() === fingerprint(b).toLowerCase();
  };

  return Object.freeze({
    algorithm,
    fallbackReason,
    tailSampleBytes: TAIL_SAMPLE_BYTES,
    fingerprint,
    fingerprintChunks,
    createAccumulator,
    matches,
    compare,
    hashFileKey,
    isSupportedHash,
  });
}

module.exports = {
  XXH64_PREFIX,
  SHA256_PREFIX,
  createPdfHashRuntime,
  isSupportedHash,
  hashFileKey,
};
