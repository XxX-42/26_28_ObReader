/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const { sha256 } = require("@noble/hashes/sha256");
const verifiedBases = new WeakMap();
function bytes(value) {
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") return new Uint8Array(value);
  throw new TypeError("Invalid recovery bytes");
}
function hash(value, hashRuntime = null) {
  return hashRuntime?.fingerprint(bytes(value)) ||
    Array.from(sha256(bytes(value)), n => n.toString(16).padStart(2, "0")).join("");
}
function matches(value, expectedHash, hashRuntime = null) {
  if (hashRuntime) return hashRuntime.matches(bytes(value), expectedHash);
  const actual = hash(value);
  return actual === expectedHash || `sha256-v1:${actual}` === expectedHash;
}
function safeHashKey(value, hashRuntime = null) {
  return hashRuntime?.hashFileKey(value) ||
    String(value).replace(/^xxh64-v1:/i, "xxh64-v1-").replace(/^sha256-v1:/i, "sha256-v1-");
}
function whole(value) {
  const a = bytes(value);
  return a.byteOffset === 0 && a.byteLength === a.buffer.byteLength ? a.buffer : a.slice().buffer;
}
function prefix(data, base) {
  if (!base || !base.length || data.length <= base.length) return false;
  for (let i = 0; i < base.length; i++) if (data[i] !== base[i]) return false;
  return true;
}
async function verify(adapter, file, expectedHash, expectedLength, hashRuntime = null) {
  const result = await adapter.readBinary(file);
  if (result.byteLength !== expectedLength || !matches(result, expectedHash, hashRuntime)) throw new Error("恢复记录写后校验失败");
  return result;
}
async function sharedBase(adapter, root, base, ensureDirectory, hashRuntime = null) {
  const digest = hash(base, hashRuntime), file = `${root}/.bases/${safeHashKey(digest, hashRuntime)}.pdf`;
  let cache = verifiedBases.get(adapter);
  if (!cache) { cache = new Map(); verifiedBases.set(adapter, cache); }
  const alreadyTracked = cache.has(file);
  if (!cache.has(file)) {
    const pending = (async () => {
      await ensureDirectory(adapter, `${root}/.bases`);
      if (!(await adapter.exists(file))) await adapter.writeBinary(file, whole(base));
      await verify(adapter, file, digest, base.length, hashRuntime);
    })();
    cache.set(file, pending);
    pending.catch(() => { if (cache.get(file) === pending) cache.delete(file); });
  }
  await cache.get(file);
  // Revalidate on every acknowledged revision. A shared base is immutable by
  // convention, but sync/file providers can still change it outside our queue.
  // Read and release sequentially rather than retaining another full snapshot.
  if (alreadyTracked) await verify(adapter, file, digest, base.length, hashRuntime);
  return { file, hash: digest, length: base.length };
}
async function writeDeltaRecovery({ adapter, root, data, bases, metadata, ensureDirectory, hashRuntime = null }) {
  const output = bytes(data);
  const base = bases.filter(Boolean).map(bytes).filter(a => prefix(output, a)).sort((a, b) => b.length - a.length)[0];
  if (!base) return null;
  // Store the byte-exact PDF.js/prepared branch, including appearance resources.
  // This is not an operation-only log that would need a live Viewer to replay.
  const shared = await sharedBase(adapter, root, base, ensureDirectory, hashRuntime);
  const suffix = output.subarray(base.length);
  const candidatePath = `${root}/${metadata.candidateId}.delta`, metadataPath = `${root}/${metadata.candidateId}.json`;
  const record = { ...metadata, schema: 2, storage: "pdf-prefix-delta", candidateFile: `${metadata.candidateId}.delta`,
    completed: true,
    recoveryBase: { file: shared.file.slice(root.length + 1), hash: shared.hash, length: shared.length },
    deltaHash: hash(suffix, hashRuntime), deltaLength: suffix.length,
    outputHash: hash(output, hashRuntime), outputLength: output.length };
  try {
    await adapter.writeBinary(candidatePath, whole(suffix));
    await verify(adapter, candidatePath, record.deltaHash, record.deltaLength, hashRuntime);
    // The JSON is the completion marker. No dirty-close acknowledgement before
    // both the shared base and this exact revision's delta have been verified.
    await adapter.write(metadataPath, JSON.stringify(record, null, 2) + "\n");
    const saved = await adapter.read(metadataPath);
    if (saved !== JSON.stringify(record, null, 2) + "\n") throw new Error("恢复完成记录校验失败");
  } catch (error) {
    for (const file of [metadataPath, candidatePath]) { try { if (await adapter.exists(file)) await adapter.remove(file); } catch {} }
    throw error;
  }
  return { candidatePath, metadataPath, metadata: record };
}
async function readDeltaRecovery(adapter, root, record, hashRuntime = null) {
  const m = record.metadata, b = m.recoveryBase;
  if (m.schema !== 2 || m.storage !== "pdf-prefix-delta" ||
      !/^\.bases\/(?:[a-f0-9]{64}|xxh64-v1-[a-f0-9]{16}|sha256-v1-[a-f0-9]{64})\.pdf$/i.test(b?.file || "") ||
      !/^[a-zA-Z0-9_-]+\.delta$/.test(m.candidateFile || "") ||
      !(hashRuntime?.isSupportedHash(b?.hash) ?? (/^[a-f0-9]{64}$/i.test(b?.hash || ""))) ||
      !Number.isSafeInteger(b.length) || b.length < 1 ||
      !(hashRuntime?.isSupportedHash(m.deltaHash) ?? (/^[a-f0-9]{64}$/i.test(m.deltaHash || ""))) ||
      !Number.isSafeInteger(m.deltaLength) || m.deltaLength < 1 ||
      !(hashRuntime?.isSupportedHash(m.outputHash) ?? (/^[a-f0-9]{64}$/i.test(m.outputHash || ""))) ||
      m.outputLength !== b.length + m.deltaLength) throw new Error("恢复记录格式无效");
  const baseline = new Uint8Array(await verify(adapter, `${root}/${b.file}`, b.hash, b.length, hashRuntime));
  const delta = new Uint8Array(await verify(adapter, `${root}/${m.candidateFile}`, m.deltaHash, m.deltaLength, hashRuntime));
  const output = new Uint8Array(m.outputLength); output.set(baseline); output.set(delta, baseline.length);
  if (!matches(output, m.outputHash, hashRuntime)) throw new Error("恢复 PDF 校验失败");
  return output.buffer;
}
module.exports = { writeDeltaRecovery, readDeltaRecovery };
