/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

const { canonicalJson, seal, verify } = require("./canonical.cjs");
const TAGGED_HASH = /^(?:xxh64-v1:[a-f0-9]{16}|sha256-v1:[a-f0-9]{64})$/i;

function codedError(code, message, cause) {
  const error = new Error(message);
  error.name = "WalSidecarError";
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function safePath(path) {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") &&
    !path.split("/").some((part) => !part || part === "." || part === "..");
}

function directoryFor(path) {
  const offset = path.lastIndexOf("/");
  return offset === -1 ? "" : path.slice(0, offset);
}

function makeToken() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function createStorageIo({ adapter, hash, verifyHash, token = makeToken } = {}) {
  if (!adapter || typeof adapter.read !== "function" || typeof adapter.write !== "function" ||
      typeof adapter.exists !== "function" || typeof adapter.mkdir !== "function" ||
      typeof adapter.rename !== "function") {
    throw new TypeError("A Vault DataAdapter with read/write/exists/mkdir/rename is required.");
  }
  if (typeof hash !== "function") throw new TypeError("An injected content hash function is required.");

  async function ensureDirectory(path) {
    if (!safePath(path)) throw codedError("WAL_PATH_INVALID", "A storage path is unsafe.");
    const directory = directoryFor(path);
    if (!directory) return;
    const segments = directory.split("/");
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!(await adapter.exists(current))) await adapter.mkdir(current);
    }
  }

  async function readRaw(path) {
    if (!safePath(path)) throw codedError("WAL_PATH_INVALID", "A storage path is unsafe.");
    if (!(await adapter.exists(path))) return null;
    const raw = await adapter.read(path);
    if (typeof raw !== "string") throw codedError("WAL_FILE_INVALID", `Expected UTF-8 text at ${path}.`);
    return raw;
  }

  async function verifyEnvelope(parsed) {
    if (typeof verifyHash !== "function") return verify(parsed, hash);
    if (!TAGGED_HASH.test(parsed.integrity || "")) {
      throw codedError("WAL_INTEGRITY_INVALID", "The persisted integrity hash has an unsupported format.");
    }
    const unsigned = {};
    for (const key of Object.keys(parsed)) if (key !== "integrity") unsigned[key] = parsed[key];
    const bytes = new TextEncoder().encode(canonicalJson(unsigned));
    if (!(await verifyHash(bytes, parsed.integrity))) {
      throw codedError("WAL_INTEGRITY_MISMATCH", "The persisted integrity hash does not match its contents.");
    }
    return unsigned;
  }

  async function decodeRaw(raw, { path, validate } = {}) {
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (error) { throw codedError("WAL_JSON_INVALID", `Malformed JSON at ${path || "storage path"}.`, error); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw codedError("WAL_ENVELOPE_INVALID", `Expected an object envelope at ${path || "storage path"}.`);
    }
    const value = await verifyEnvelope(parsed);
    if (typeof validate === "function") await validate(value);
    return value;
  }

  async function readJson(path, { validate, missing = null } = {}) {
    let canonicalRaw = null;
    let canonicalError = null;
    try {
      canonicalRaw = await readRaw(path);
      if (canonicalRaw !== null) return await decodeRaw(canonicalRaw, { path, validate });
    } catch (error) { canonicalError = error; }

    let pendingRaw = null;
    try {
      pendingRaw = await readRaw(`${path}.pending`);
      if (pendingRaw !== null) return await decodeRaw(pendingRaw, { path: `${path}.pending`, validate });
    } catch (error) {
      if (canonicalError) error.cause = canonicalError;
      throw codedError("WAL_FILE_INVALID", `No valid persisted file is available at ${path}.`, error);
    }
    if (canonicalRaw === null && pendingRaw === null && !canonicalError) return missing;
    throw codedError("WAL_FILE_INVALID", `No valid persisted file is available at ${path}.`, canonicalError);
  }

  async function throwIfDocumentCollision(raw, path, expectedIdentity, getIdentity, validateCandidate) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return; }
    let candidateIdentity;
    try { candidateIdentity = getIdentity(parsed); } catch { return; }
    if (!candidateIdentity || candidateIdentity.docKey !== expectedIdentity.docKey ||
        typeof candidateIdentity.documentId !== "string" ||
        candidateIdentity.documentId === expectedIdentity.documentId) return;
    try {
      await decodeRaw(raw, {
        path,
        validate: (value) => validateCandidate(value, candidateIdentity),
      });
    } catch { return; }
    throw codedError("DOC_KEY_COLLISION", "A verified record assigns this document key to a different full identity.");
  }

  async function readJsonWithDocumentIdentity(path, {
    expectedIdentity,
    validate,
    getIdentity,
    validateCandidate,
    missing = null,
  } = {}) {
    if (!expectedIdentity || typeof expectedIdentity !== "object" ||
        typeof getIdentity !== "function" || typeof validateCandidate !== "function") {
      throw new TypeError("Document identity collision checks require identity and validation callbacks.");
    }
    let primaryRaw = null;
    try { primaryRaw = await readRaw(path); } catch { /* The normal reader reports storage errors. */ }
    if (primaryRaw !== null) {
      try { return await decodeRaw(primaryRaw, { path, validate }); }
      catch {
        await throwIfDocumentCollision(primaryRaw, path, expectedIdentity, getIdentity, validateCandidate);
      }
    }
    try {
      return await readJson(path, { validate, missing });
    } catch (error) {
      for (const candidatePath of [path, `${path}.pending`]) {
        let raw = null;
        try { raw = await readRaw(candidatePath); } catch { /* Preserve the normal read error below. */ }
        if (raw !== null) {
          await throwIfDocumentCollision(raw, candidatePath, expectedIdentity, getIdentity, validateCandidate);
        }
      }
      throw error;
    }
  }

  async function writeVerified(path, raw, validate) {
    await adapter.write(path, raw);
    const saved = await readRaw(path);
    if (saved !== raw) throw codedError("WAL_WRITE_UNVERIFIED", `Write verification failed at ${path}.`);
    await decodeRaw(saved, { path, validate });
    return saved;
  }

  async function removeIfPresent(path) {
    if (typeof adapter.remove !== "function") return;
    try {
      if (await adapter.exists(path)) await adapter.remove(path);
    } catch { /* Best-effort cleanup; pending files are never treated as records. */ }
  }

  async function verifiedDuplicateStage(path) {
    const marker = path.lastIndexOf(".pending-");
    if (marker < 0) return false;
    try {
      const staged = await readRaw(path), published = await readRaw(path.slice(0, marker));
      if (staged === null || staged !== published) return false;
      await decodeRaw(published, { path: path.slice(0, marker) });
      return true;
    } catch { return false; }
  }

  async function writeJsonAtomic(path, value, { validate, createOnly = false, uniquePending = false, acceptConcurrent = false } = {}) {
    if (!safePath(path)) throw codedError("WAL_PATH_INVALID", "A storage path is unsafe.");
    const serialized = canonicalJson(await seal(value, hash));
    const sealedValue = JSON.parse(serialized);
    if (typeof validate === "function") await validate(await verify(sealedValue, hash));

    let oldRaw = null;
    let oldIsValid = false;
    const current = await readRaw(path);
    if (current !== null) {
      oldRaw = current;
      try {
        await decodeRaw(current, { path, validate });
        oldIsValid = true;
      } catch { /* A corrupt target can be repaired from a verified new value. */ }
    }
    if (createOnly && current !== null) {
      throw codedError("WAL_SIDECAR_EXISTS", `A file already exists at ${path}; its bytes are retained.`);
    }

    const operationToken = String(token());
    if (!operationToken || operationToken.includes("/") || operationToken.includes("..")) {
      throw codedError("WAL_TOKEN_INVALID", "A temporary file token is invalid.");
    }
    const uniqueStaging = uniquePending || createOnly;
    if (uniqueStaging && !/^[A-Za-z0-9_-]{1,256}$/.test(operationToken)) {
      throw codedError("WAL_TOKEN_INVALID", "A unique temporary file token is invalid.");
    }
    const pendingPath = uniqueStaging ? `${path}.pending-${operationToken}` : `${path}.pending`;
    await ensureDirectory(path);
    try {
      if (uniqueStaging && await adapter.exists(pendingPath)) throw codedError("WAL_PENDING_EXISTS", "A unique temporary file already exists.");
      await adapter.write(pendingPath, serialized);
      const staged = await readRaw(pendingPath);
      if (staged !== serialized) throw codedError("WAL_WRITE_UNVERIFIED", `Temporary write verification failed at ${pendingPath}.`);
      await decodeRaw(staged, { path: pendingPath, validate });

      try {
        if (createOnly) {
          // The public adapter copy contract refuses an existing destination.
          // Do not silently fall back to a rename that can replace its target.
          if (typeof adapter.copy !== "function") throw codedError("WAL_CREATE_ONLY_UNAVAILABLE", "The adapter cannot publish a create-only file safely.");
          await adapter.copy(pendingPath, path);
        } else await adapter.rename(pendingPath, path);
      } catch (renameError) {
        // A create-only write must never fall back to unconditional overwrite:
        // another participant may have published a file after the initial read.
        // Keep the staged bytes and let the caller inspect/retry safely.
        if (createOnly) throw renameError;
        // Adapters that refuse rename over an existing file can still replace
        // it with their atomic write primitive after the pending file verifies.
        try { await adapter.write(path, serialized); }
        catch (replacementError) {
          if (oldIsValid && oldRaw !== null) {
            try { await writeVerified(path, oldRaw, validate); }
            catch { /* Preserve the original write error; pending data remains diagnosable. */ }
          }
          replacementError.cause = renameError;
          throw replacementError;
        }
      }

      const confirmed = await readRaw(path);
      if (confirmed !== serialized && !acceptConcurrent) throw codedError("WAL_WRITE_UNVERIFIED", `Atomic replacement verification failed at ${path}.`);
      const result = await decodeRaw(confirmed, { path, validate });
      // A sync client may have replaced a create-only copy's source. Without
      // conditional delete, retaining it is the only safe option.
      if (!createOnly) await removeIfPresent(pendingPath);
      return result;
    } catch (error) {
      if (oldIsValid && oldRaw !== null) {
        let replacementIsValid = false;
        try { replacementIsValid = Boolean(await decodeRaw(await readRaw(path), { path, validate })); }
        catch { replacementIsValid = false; }
        if (!replacementIsValid) {
          try { await writeVerified(path, oldRaw, validate); }
          catch { /* The last valid value remains in memory only if the adapter itself is failing. */ }
        }
      }
      throw error;
    }
  }

  async function list(path) {
    if (typeof adapter.list !== "function") throw new TypeError("The DataAdapter must support list().");
    const result = await adapter.list(path);
    return {
      files: Array.isArray(result?.files) ? result.files.filter((file) => typeof file === "string") : [],
      folders: Array.isArray(result?.folders) ? result.folders.filter((folder) => typeof folder === "string") : [],
    };
  }

  return Object.freeze({ adapter, hash, verifyHash, ensureDirectory, readRaw, decodeRaw, readJson,
    readJsonWithDocumentIdentity, writeJsonAtomic, verifiedDuplicateStage, list, safePath });
}

module.exports = { createStorageIo, safePath };
