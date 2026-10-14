/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

// Read-only compatibility for binary recovery files produced before 0.6.0.
// The 0.6.0 runtime must never create new PDF or prefix-delta recovery files.
const { sha256 } = require("@noble/hashes/sha2");

function bytes(value) {
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") return new Uint8Array(value);
  throw new Error("Invalid recovery bytes");
}

function matches(value, expectedHash, hashRuntime = null) {
  const input = bytes(value);
  if (hashRuntime) return hashRuntime.matches(input, expectedHash);
  const digest = Array.from(sha256(input), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return digest === expectedHash || `sha256-v1:${digest}` === expectedHash;
}

async function verify(adapter, file, expectedHash, expectedLength, hashRuntime = null) {
  const result = await adapter.readBinary(file);
  if (result.byteLength !== expectedLength || !matches(result, expectedHash, hashRuntime)) {
    throw new Error("恢复记录写后校验失败");
  }
  return result;
}

async function readDeltaRecovery(adapter, root, record, hashRuntime = null) {
  const metadata = record.metadata;
  const recoveryBase = metadata?.recoveryBase;
  const supportedHash = (value) => hashRuntime?.isSupportedHash(value) ?? /^[a-f0-9]{64}$/i.test(value || "");
  if (metadata?.schema !== 2 || metadata.storage !== "pdf-prefix-delta" ||
      !/^\.bases\/(?:[a-f0-9]{64}|xxh64-v1-[a-f0-9]{16}|sha256-v1-[a-f0-9]{64})\.pdf$/i.test(recoveryBase?.file || "") ||
      !/^[a-zA-Z0-9_-]+\.delta$/.test(metadata.candidateFile || "") ||
      !supportedHash(recoveryBase?.hash) || !Number.isSafeInteger(recoveryBase.length) || recoveryBase.length < 1 ||
      !supportedHash(metadata.deltaHash) || !Number.isSafeInteger(metadata.deltaLength) || metadata.deltaLength < 1 ||
      !supportedHash(metadata.outputHash) || metadata.outputLength !== recoveryBase.length + metadata.deltaLength) {
    throw new Error("恢复记录格式无效");
  }
  const baseline = new Uint8Array(await verify(adapter, `${root}/${recoveryBase.file}`,
    recoveryBase.hash, recoveryBase.length, hashRuntime));
  const delta = new Uint8Array(await verify(adapter, `${root}/${metadata.candidateFile}`,
    metadata.deltaHash, metadata.deltaLength, hashRuntime));
  const output = new Uint8Array(metadata.outputLength);
  output.set(baseline);
  output.set(delta, baseline.length);
  if (!matches(output, metadata.outputHash, hashRuntime)) throw new Error("恢复 PDF 校验失败");
  return output.buffer;
}

module.exports = { readDeltaRecovery };
