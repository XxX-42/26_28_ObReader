/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

// Durable sync checkpoints. Schema 2 stores one merge baseline and represents
// incremental checkpoints as a verified anchor plus checksummed append records.
// Schema 1 remains readable so upgrades do not strand existing recovery files.
function createPdfJournal({ adapter, root, normalizePath, fingerprint, bytesEqual,
  fingerprintMatches, isSupportedHash, hashFileKey, pathKey,
  fingerprintChunks, createFingerprintAccumulator, ensureDirectory,
  makeToken = () => `${Date.now()}-${Math.random()}` }) {
  const bytesView = (value) => {
    const tag = Object.prototype.toString.call(value);
    if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError("Invalid PDF byte data.");
  };
  const copy = (value) => Uint8Array.from(bytesView(value));
  const asBuffer = (value) => {
    const view = bytesView(value);
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  };
  const equal = (left, right) => bytesEqual(bytesView(left), bytesView(right));
  const normalizedRoot = normalizePath(root);
  const keyForPath = (path) => pathKey
    ? pathKey(normalizePath(path))
    : (hashFileKey ? hashFileKey(fingerprint(new TextEncoder().encode(normalizePath(path))))
      : fingerprint(new TextEncoder().encode(normalizePath(path))));
  const pathsFor = (path) => {
    const key = keyForPath(path);
    return {
      key,
      manifest: `${normalizedRoot}/${key}.json`,
      previousManifest: `${normalizedRoot}/${key}.json.previous`,
      schema1Pdf: `${normalizedRoot}/${key}.pdf`,
      schema1Base: `${normalizedRoot}/${key}.base.pdf`,
      base(hash) { return `${normalizedRoot}/${key}.base-${hashFileKey ? hashFileKey(hash) : hash}.pdf`; },
      preferredBase: `${normalizedRoot}/${key}.base.pdf`,
      full(hash, token) { return `${normalizedRoot}/${key}.checkpoint-${hashFileKey ? hashFileKey(hash) : hash}-${token}.pdf`; },
      anchor(hash, token) { return `${normalizedRoot}/${key}.anchor-${hashFileKey ? hashFileKey(hash) : hash}-${token}.pdf`; },
      delta(sequence, token) { return `${normalizedRoot}/${key}.delta-${sequence}-${token}.bin`; },
      record(sequence, token) { return `${normalizedRoot}/${key}.record-${sequence}-${token}.json`; },
    };
  };
  const validPath = (path) => typeof path === "string" && path.startsWith(`${normalizedRoot}/`) &&
    !path.split("/").some((part) => part === "..");
  const invalid = (message) => Object.assign(new Error(message), { code: "PDF_JOURNAL_INVALID" });
  const hashIsValid = (value) => isSupportedHash ? isSupportedHash(value) : /^[a-f0-9]{64}$/i.test(value || "");
  const hashMatches = (value, expected) => fingerprintMatches
    ? fingerprintMatches(bytesView(value), expected)
    : fingerprint(bytesView(value)) === expected;
  const fingerprintRecord = (value) => ({ hash: fingerprint(bytesView(value)), length: bytesView(value).byteLength });
  async function readVerified(path, hash, length) {
    if (!validPath(path) || !(await adapter.exists(path))) throw invalid("Checkpoint segment is missing");
    const saved = bytesView(await adapter.readBinary(path));
    if (saved.byteLength !== length || !hashMatches(saved, hash)) throw invalid("Checkpoint segment verification failed");
    return saved;
  }
  async function writeVerified(path, value) {
    const data = bytesView(value);
    await adapter.writeBinary(path, asBuffer(data));
    const saved = await readVerified(path, fingerprint(data), data.byteLength);
    return { path, file: path, hash: fingerprint(saved), length: saved.byteLength };
  }
  async function readManifestCandidates(path) {
    const manifests = [];
    for (const candidate of [path, `${path}.previous`]) {
      if (!(await adapter.exists(candidate))) continue;
      const raw = await adapter.read(candidate);
      let metadata;
      try { metadata = JSON.parse(raw); }
      catch { continue; /* A torn newest manifest falls back to its previous verified copy. */ }
      if (metadata && (metadata.schema === 1 || metadata.schema === 2)) manifests.push(metadata);
    }
    return manifests;
  }
  async function readManifest(path) {
    return (await readManifestCandidates(path))[0] || null;
  }
  async function writeManifest(path, metadata) {
    if (await adapter.exists(path)) {
      const old = await adapter.read(path);
      if (typeof old === "string") {
        let validJson = false;
        let oldMetadata;
        try {
          oldMetadata = JSON.parse(old);
          validJson = true;
        } catch { /* Keep the last previous manifest if the current one is torn. */ }
        if (validJson) {
          let oldIsValid = true;
          try { await validateManifest(oldMetadata, metadata.path, { materialize: false }); }
          catch (error) {
            if (error.code !== "PDF_JOURNAL_INVALID") throw error;
            oldIsValid = false;
          }
          if (oldIsValid) {
            const previousPath = `${path}.previous`;
            await adapter.write(previousPath, old);
            if (await adapter.read(previousPath) !== old) {
              throw new Error("Checkpoint backup manifest write verification failed");
            }
          }
        }
      }
    }
    const text = JSON.stringify(metadata);
    await adapter.write(path, text);
    const saved = await adapter.read(path);
    if (saved !== text) throw new Error("Checkpoint manifest write verification failed");
  }
  async function ensureBase(paths, path, baseBytes) {
    const info = fingerprintRecord(baseBytes);
    let file = paths.preferredBase;
    if (await adapter.exists(file)) {
      try {
        const existing = bytesView(await adapter.readBinary(file));
        if (existing.byteLength !== info.length || !hashMatches(existing, info.hash)) file = paths.base(info.hash);
      } catch { file = paths.base(info.hash); }
    }
    if (!(await adapter.exists(file))) await writeVerified(file, baseBytes);
    else await readVerified(file, info.hash, info.length);
    return { file, ...info };
  }
  function validatePath(metadata, requestedPath) {
    if (metadata.path !== normalizePath(requestedPath)) throw invalid("Checkpoint path mismatch");
  }
  async function validateManifest(metadata, requestedPath, { materialize = true } = {}) {
    const normalizedPath = normalizePath(requestedPath);
    const paths = pathsFor(normalizedPath);
    validatePath(metadata, normalizedPath);
    if (metadata.schema === 1) {
      const [pdf, base] = await Promise.all([
        adapter.readBinary(paths.schema1Pdf), adapter.readBinary(paths.schema1Base),
      ]);
      const checkpointBytes = bytesView(pdf);
      const baseBytes = bytesView(base);
      if (!hashMatches(checkpointBytes, metadata.hash) || !hashMatches(baseBytes, metadata.baseHash)) {
        throw invalid("Checkpoint verification failed");
      }
      return { schema: 1, status: metadata.status, path: normalizedPath,
        checkpointBytes, checkpointChunks: [checkpointBytes], baseBytes,
        hash: metadata.hash, length: checkpointBytes.byteLength,
        baseHash: metadata.baseHash, baseLength: baseBytes.byteLength, metadata };
    }
    if (metadata.schema !== 2 || !metadata.base || !metadata.checkpoint) {
      throw invalid("Unsupported checkpoint schema");
    }
    const baseBytes = await readVerified(metadata.base.file, metadata.base.hash, metadata.base.length);
    const checkpoint = metadata.checkpoint;
    if (!hashIsValid(checkpoint.hash) || !Number.isSafeInteger(checkpoint.length) || checkpoint.length < 1) {
      throw invalid("Checkpoint metadata is invalid");
    }
    let checkpointBytes = null;
    let checkpointChunks = materialize ? [] : null;
    let accumulator = createFingerprintAccumulator?.(checkpoint.hash) || null;
    const addChunk = (chunk) => {
      if (accumulator) accumulator.update(chunk);
      if (checkpointChunks) checkpointChunks.push(chunk);
      else if (!accumulator) checkpointChunks = [chunk];
    };
    if (checkpoint.kind === "full") {
      const fullBytes = await readVerified(checkpoint.file, checkpoint.hash, checkpoint.length);
      addChunk(fullBytes);
      if (materialize) checkpointBytes = fullBytes;
    } else if (checkpoint.kind === "append" && typeof checkpoint.head === "string") {
      const reverseChain = [];
      const seen = new Set();
      let pointer = checkpoint.head;
      while (pointer) {
        if (!validPath(pointer) || seen.has(pointer) || reverseChain.length >= 100000) {
          throw invalid("Checkpoint journal record chain is invalid");
        }
        seen.add(pointer);
        const raw = await adapter.read(pointer);
        let record;
        try { record = JSON.parse(raw); }
        catch { throw invalid("Checkpoint journal record is malformed"); }
        if (!record || record.schema !== 1 || record.path !== normalizedPath ||
            !Number.isSafeInteger(record.sequence) || !record.suffix ||
            !hashIsValid(record.hash) || !Number.isSafeInteger(record.length)) {
          throw invalid("Checkpoint journal record metadata is invalid");
        }
        reverseChain.push({ path: pointer, record });
        if (record.parentRecord === null) break;
        if (typeof record.parentRecord !== "string") throw invalid("Checkpoint journal parent link is invalid");
        pointer = record.parentRecord;
      }
      if (!reverseChain.length || reverseChain.at(-1).record.parentRecord !== null) {
        throw invalid("Checkpoint journal root record is missing");
      }
      const chain = reverseChain.reverse();
      const rootRecord = chain[0].record;
      const anchor = rootRecord.anchor;
      if (!anchor || !Number.isSafeInteger(anchor.length) || anchor.length < 1 ||
          !hashIsValid(anchor.hash)) {
        throw invalid("Checkpoint journal anchor is invalid");
      }
      let anchorBytes;
      if (anchor.kind === "base") {
        if (anchor.file !== metadata.base.file || anchor.hash !== metadata.base.hash || anchor.length !== metadata.base.length) {
          throw invalid("Checkpoint journal base anchor mismatch");
        }
        anchorBytes = baseBytes;
      } else if (anchor.kind === "file") {
        anchorBytes = await readVerified(anchor.file, anchor.hash, anchor.length);
      } else throw invalid("Unsupported checkpoint journal anchor");

      addChunk(anchorBytes);
      let parentHash = anchor.hash;
      let parentLength = anchor.length;
      let finalLength = anchor.length;
      let previousSequence = 0;
      for (let index = 0; index < chain.length; index += 1) {
        const { path: recordPath, record } = chain[index];
        const parentRecord = index === 0 ? null : chain[index - 1].path;
        if (record.parentRecord !== parentRecord || (index === 0 ? !record.anchor : record.anchor !== undefined) ||
            !Number.isSafeInteger(record.suffix.length) || record.suffix.length < 1 ||
            record.parentHash !== parentHash || record.parentLength !== parentLength ||
            record.length !== record.parentLength + record.suffix.length ||
            record.sequence <= previousSequence) {
          throw invalid("Checkpoint journal ancestry verification failed");
        }
        const suffix = await readVerified(record.suffix.file, record.suffix.hash, record.suffix.length);
        addChunk(suffix);
        parentHash = record.hash;
        parentLength = record.length;
        finalLength += suffix.byteLength;
        previousSequence = record.sequence;
      }
      if (parentHash !== checkpoint.hash || parentLength !== checkpoint.length || finalLength !== checkpoint.length ||
          !Number.isSafeInteger(metadata.sequence) || previousSequence !== metadata.sequence ||
          (accumulator ? accumulator.digest() : fingerprintChunks(checkpointChunks)) !== checkpoint.hash) {
        throw invalid("Checkpoint journal watermark verification failed");
      }
    } else if (checkpoint.kind === "append") {
      const anchor = checkpoint.anchor;
      if (!anchor || !Number.isSafeInteger(anchor.length) || anchor.length < 1 ||
          !hashIsValid(anchor.hash)) {
        throw invalid("Checkpoint journal anchor is invalid");
      }
      let anchorBytes;
      if (anchor.kind === "base") {
        if (anchor.file !== metadata.base.file || anchor.hash !== metadata.base.hash || anchor.length !== metadata.base.length) {
          throw invalid("Checkpoint journal base anchor mismatch");
        }
        anchorBytes = baseBytes;
      } else if (anchor.kind === "file") {
        anchorBytes = await readVerified(anchor.file, anchor.hash, anchor.length);
      } else throw invalid("Unsupported checkpoint journal anchor");

      const records = checkpoint.records;
      if (!Array.isArray(records) || records.length === 0) throw invalid("Checkpoint journal has no committed records");
      addChunk(anchorBytes);
      let parentHash = anchor.hash;
      let parentLength = anchor.length;
      let finalLength = anchor.length;
      let previousSequence = 0;
      for (const record of records) {
        if (!Number.isSafeInteger(record.sequence) || record.sequence <= previousSequence ||
            record.parentHash !== parentHash || record.parentLength !== parentLength ||
            !Number.isSafeInteger(record.suffixLength) || record.suffixLength < 1 ||
            record.length !== record.parentLength + record.suffixLength ||
            !hashIsValid(record.hash)) {
          throw invalid("Checkpoint journal ancestry verification failed");
        }
        const suffix = await readVerified(record.file, record.suffixHash, record.suffixLength);
        addChunk(suffix);
        parentHash = record.hash;
        parentLength = record.length;
        finalLength += suffix.byteLength;
        previousSequence = record.sequence;
      }
      if (parentHash !== checkpoint.hash || parentLength !== checkpoint.length || finalLength !== checkpoint.length ||
          !Number.isSafeInteger(metadata.sequence) || previousSequence !== metadata.sequence ||
          (accumulator ? accumulator.digest() : fingerprintChunks(checkpointChunks)) !== checkpoint.hash) {
        throw invalid("Checkpoint journal watermark verification failed");
      }
    } else throw invalid("Unsupported checkpoint representation");
    return { schema: 2, status: metadata.status, path: normalizedPath,
      checkpointBytes, checkpointChunks, baseBytes, hash: checkpoint.hash, length: checkpoint.length,
      baseHash: metadata.base.hash, baseLength: metadata.base.length,
      sequence: metadata.sequence || 0, metadata };
  }
  async function load(path) {
    const normalizedPath = normalizePath(path);
    const paths = pathsFor(normalizedPath);
    const candidates = await readManifestCandidates(paths.manifest);
    if (!candidates.length) return null;
    let lastError;
    for (const metadata of candidates) {
      try {
        const verified = await validateManifest(metadata, normalizedPath);
        const checkpointBytes = verified.checkpointBytes || new Uint8Array(verified.length);
        if (!verified.checkpointBytes) {
          let offset = 0;
          for (const chunk of verified.checkpointChunks) {
            checkpointBytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
        }
        return { ...verified, checkpointBytes, checkpointChunks: undefined };
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error("Checkpoint verification failed");
  }
  async function beginFull({ path, baseBytes, checkpointBytes, metadata: extra = {} }) {
    const normalizedPath = normalizePath(path);
    const paths = pathsFor(normalizedPath);
    await ensureDirectory(adapter, normalizedRoot);
    const base = await ensureBase(paths, normalizedPath, baseBytes);
    const checkpointInfo = fingerprintRecord(checkpointBytes);
    let checkpoint;
    if (checkpointInfo.hash === base.hash && checkpointInfo.length === base.length && equal(checkpointBytes, baseBytes)) {
      checkpoint = { kind: "full", file: base.file, ...checkpointInfo };
    } else {
      const file = paths.full(checkpointInfo.hash, makeToken());
      checkpoint = { kind: "full", ...(await writeVerified(file, checkpointBytes)) };
    }
    const prior = await readManifest(paths.manifest);
    const sequence = Number.isSafeInteger(prior?.sequence) ? prior.sequence + 1 : 1;
    const record = { schema: 2, status: "pending", path: normalizedPath, base,
      checkpoint, sequence, metadata: extra, updatedAt: new Date().toISOString() };
    await writeManifest(paths.manifest, record);
    return record;
  }
  async function beginAppend({ path, baseBytes, parentBytes, suffix, outputFingerprint,
    outputLength, metadata: extra = {} }) {
    const normalizedPath = normalizePath(path);
    const paths = pathsFor(normalizedPath);
    const parent = bytesView(parentBytes);
    const delta = bytesView(suffix);
    const parentInfo = fingerprintRecord(parent);
    if (!hashIsValid(outputFingerprint) ||
        !Number.isSafeInteger(outputLength) || outputLength !== parentInfo.length + delta.byteLength) {
      throw new Error("Incremental checkpoint metadata is invalid");
    }
    await ensureDirectory(adapter, normalizedRoot);
    const base = await ensureBase(paths, normalizedPath, baseBytes);
    const manifests = await readManifestCandidates(paths.manifest);
    let prior = null;
    let latest = null;
    for (const candidate of manifests) {
      try {
        const verified = await validateManifest(candidate, normalizedPath, { materialize: false });
        if (!latest) latest = verified;
        if (!prior && verified.length === parentInfo.length && hashMatches(parent, verified.hash)) prior = verified;
      } catch { /* A damaged current record does not hide a valid previous one. */ }
    }
    const sequence = Math.max(Number.isSafeInteger(latest?.sequence) ? latest.sequence : 0,
      Number.isSafeInteger(prior?.sequence) ? prior.sequence : 0, 0) + 1;
    let anchor;
    let anchorMetadata = null;
    let parentRecord = null;
    if (parentInfo.length === base.length && equal(parent, baseBytes)) {
      // A matching checkpoint can still point at an older duplicate full
      // file. Prefer the shared base directly so the first append never
      // copies that full PDF into a separate journal anchor.
      anchor = { kind: "base", file: base.file, hash: base.hash, length: base.length };
    } else if (prior?.schema === 2 && prior.length === parentInfo.length) {
      const previous = prior.metadata.checkpoint;
      if (previous.kind === "append" && typeof previous.head === "string") {
        parentRecord = previous.head;
      } else if (previous.kind === "full" && previous.file === base.file) {
        anchor = { kind: "base", file: base.file, hash: base.hash, length: base.length };
        anchorMetadata = prior.metadata.metadata || null;
      } else if (previous.kind === "full") {
        anchor = { kind: "file", file: previous.file, hash: previous.hash, length: previous.length };
        anchorMetadata = prior.metadata.metadata || null;
      } else {
        // Migrate the earlier schema-2 array representation to linked records
        // without rewriting its whole history into every new manifest.
        const savedAnchor = await writeVerified(paths.anchor(parentInfo.hash, makeToken()), parent);
        anchor = { kind: "file", ...savedAnchor };
        anchorMetadata = prior.metadata.metadata || null;
      }
    } else {
      const savedAnchor = await writeVerified(paths.anchor(parentInfo.hash, makeToken()), parent);
      anchor = { kind: "file", ...savedAnchor };
    }
    const deltaFile = paths.delta(sequence, makeToken());
    const suffixInfo = await writeVerified(deltaFile, delta);
    const entry = { schema: 1, path: normalizedPath, sequence, parentRecord,
      ...(parentRecord ? {} : { anchor, anchorMetadata }),
      suffix: { file: suffixInfo.path, hash: suffixInfo.hash, length: suffixInfo.length },
      parentHash: parentInfo.hash, parentLength: parentInfo.length,
      hash: outputFingerprint, length: outputLength, metadata: extra };
    const recordFile = paths.record(sequence, makeToken());
    const recordText = JSON.stringify(entry);
    await adapter.write(recordFile, recordText);
    if (await adapter.read(recordFile) !== recordText) throw new Error("Checkpoint journal record write verification failed");
    const record = { schema: 2, status: "pending", path: normalizedPath, base,
      checkpoint: { kind: "append", head: recordFile,
        hash: outputFingerprint, length: outputLength },
      sequence, metadata: extra, updatedAt: new Date().toISOString() };
    await writeManifest(paths.manifest, record);
    return record;
  }
  async function confirm(path, outputFingerprint, outputLength) {
    const normalizedPath = normalizePath(path);
    const paths = pathsFor(normalizedPath);
    const metadata = await readManifest(paths.manifest);
    if (!metadata || metadata.schema !== 2 || metadata.path !== normalizedPath) {
      throw new Error("Pending checkpoint is missing");
    }
    if (metadata.checkpoint.hash !== outputFingerprint || metadata.checkpoint.length !== outputLength) {
      throw new Error("Confirmed checkpoint does not match the written PDF");
    }
    await validateManifest(metadata, normalizedPath, { materialize: false });
    metadata.status = "confirmed";
    metadata.updatedAt = new Date().toISOString();
    metadata.confirmedSequence = metadata.sequence;
    await writeManifest(paths.manifest, metadata);
  }
  async function listRecoveries() {
    if (!(await adapter.exists(normalizedRoot))) return [];
    const listing = await adapter.list(normalizedRoot);
    const candidates = [];
    for (const path of listing.files.filter((entry) => /^[a-f0-9]{64}\.json$/i.test(entry.split("/").at(-1)))) {
      let manifests;
      try { manifests = await readManifestCandidates(path); }
      catch { continue; }
      // A committed primary manifest means recovery was already acknowledged;
      // do not surface its older pending backup as a new user recovery item.
      if (manifests[0]?.status === "confirmed") continue;
      for (const metadata of manifests) {
        if (metadata.status !== "pending") continue;
        try {
          const verified = await validateManifest(metadata, metadata.path, { materialize: false });
          if (!verified || verified.status !== "pending") continue;
          candidates.push({ schema: verified.schema, path: verified.path, status: verified.status,
            hash: verified.hash, length: verified.length,
            updatedAt: verified.metadata.updatedAt || null, sequence: verified.sequence || 0 });
          break;
        } catch { /* Try the previous pending manifest before hiding this recovery. */ }
      }
    }
    return candidates.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  }
  async function readRecovery(candidate) {
    if (!candidate || typeof candidate.path !== "string") throw new TypeError("Invalid checkpoint recovery candidate");
    const loaded = await load(candidate.path);
    if (!loaded) throw new Error("Checkpoint recovery candidate is missing");
    return loaded.checkpointBytes;
  }
  return { load, beginFull, beginAppend, confirm, listRecoveries, readRecovery, pathsFor };
}

module.exports = { createPdfJournal };
