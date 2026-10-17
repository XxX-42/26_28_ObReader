"use strict";

const { canonicalHash, canonicalStringify, hashText } = require("./canonical.cjs");

const VOCABULARY_DATA_ROOT = "00_Archive/21_VocabularyData";
const MAX_SHARD_RECORDS = 512;
const MAX_SHARD_BYTES = 256 * 1024;
const HASH_PREFIX = /^[a-f0-9]{1,64}$/;
const SHARD_FILE = /^[a-f0-9]{1,64}\.json$/;
const HASH_VALUE = /^sha256-v1:[a-f0-9]{64}$/;

function codedError(code, message) {
  const error = new Error(message);
  error.name = "VocabularyShardError";
  error.code = code;
  return error;
}

function assertStoreOptions({ storeId, root, kind, idOf, maxRecords, maxBytes }) {
  if (typeof storeId !== "string" || !storeId || storeId.length > 128 || /[\u0000-\u001f\u007f]/.test(storeId)) {
    throw codedError("VOCAB_SHARD_STORE_ID_INVALID", "A stable vocabulary shard store ID is required.");
  }
  if (typeof root !== "string" || !root.startsWith(`${VOCABULARY_DATA_ROOT}/`) ||
      root.split("/").some((part) => !part || part === "." || part === ".." || /[\\\u0000-\u001f\u007f]/.test(part))) {
    throw codedError("VOCAB_SHARD_ROOT_INVALID", "Vocabulary shards must be stored beneath 00_Archive/21_VocabularyData/.");
  }
  if (typeof kind !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(kind)) {
    throw codedError("VOCAB_SHARD_KIND_INVALID", "A stable vocabulary shard kind is required.");
  }
  if (typeof idOf !== "function") throw new TypeError("Vocabulary shards require an idOf(record) function.");
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_SHARD_RECORDS) {
    throw codedError("VOCAB_SHARD_LIMIT_INVALID", `A vocabulary shard may contain at most ${MAX_SHARD_RECORDS} records.`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SHARD_BYTES) {
    throw codedError("VOCAB_SHARD_LIMIT_INVALID", `A vocabulary shard may use at most ${MAX_SHARD_BYTES} UTF-8 bytes.`);
  }
}

function utf8Length(text) {
  if (typeof TextEncoder !== "function") throw codedError("VOCAB_SHARD_ENCODER_UNAVAILABLE", "TextEncoder is required to size vocabulary shards.");
  return new TextEncoder().encode(text).byteLength;
}

function validateId(value) {
  if (typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw codedError("VOCAB_SHARD_RECORD_ID_INVALID", "Every vocabulary record needs a stable, non-empty ID.");
  }
  return value;
}

function manifestPathFor(root) {
  return `${root}/manifest.json`;
}

function hasShardFilesFromListing(listing, root) {
  if (!listing || !Array.isArray(listing.files)) {
    throw codedError("VOCAB_SHARD_DIRECTORY_LIST_INVALID", `The DataAdapter returned an invalid directory listing for ${root}.`);
  }
  const prefix = `${root}/`;
  return listing.files.some((path) => {
    if (typeof path !== "string" || !path.startsWith(prefix)) return false;
    const leaf = path.slice(prefix.length);
    return !leaf.includes("/") && SHARD_FILE.test(leaf);
  });
}

async function hasShardFilesFromAdapter(adapter, root) {
  if (!adapter || typeof adapter.exists !== "function" || typeof adapter.list !== "function") {
    throw codedError("VOCAB_SHARD_DIRECTORY_PROBE_UNAVAILABLE", "The DataAdapter must support exists() and list() to distinguish an empty shard store from an incomplete sync.");
  }
  let directoryExists;
  try { directoryExists = await adapter.exists(root); }
  catch (error) { throw codedError("VOCAB_SHARD_DIRECTORY_PROBE_FAILED", `Could not inspect shard directory ${root}: ${error.message}`); }
  if (!directoryExists) return false;
  let listing;
  try { listing = await adapter.list(root); }
  catch (error) { throw codedError("VOCAB_SHARD_DIRECTORY_PROBE_FAILED", `Could not list shard directory ${root}: ${error.message}`); }
  return hasShardFilesFromListing(listing, root);
}

function shardPathFor(root, prefix) {
  if (!HASH_PREFIX.test(prefix || "")) throw codedError("VOCAB_SHARD_PREFIX_INVALID", "A shard path requires a lowercase SHA-256 prefix.");
  return `${root}/${prefix}.json`;
}

function safeRecordMap(entries) {
  const records = Object.create(null);
  for (const [id, record] of entries) {
    Object.defineProperty(records, id, { value: record, enumerable: true, writable: true, configurable: true });
  }
  return records;
}

function shardValue({ storeId, kind, prefix, revision, records }) {
  return {
    schemaVersion: 1,
    kind: "vocabulary-shard",
    storeId,
    storeKind: kind,
    prefix,
    revision,
    records,
  };
}

function shardText(value) {
  return canonicalStringify(value);
}

function makePartition({ entries, prefix, storeId, kind, revision, maxRecords, maxBytes, root }) {
  const records = safeRecordMap(entries.map(({ id, record }) => [id, record]));
  const value = shardValue({ storeId, kind, prefix, revision, records });
  const text = shardText(value);
  const byteLength = utf8Length(text);
  if (entries.length > maxRecords || byteLength > maxBytes) return null;
  return {
    prefix,
    path: shardPathFor(root, prefix),
    value,
    text,
    hash: canonicalHash(value),
    recordCount: entries.length,
    byteLength,
  };
}

/**
 * Deterministically bucket records by the SHA-256 prefix of their stable ID.
 * An overfull bucket is recursively split one hex digit at a time. No record
 * is truncated; a record which cannot fit by itself is rejected.
 */
function partitionRecords({
  records,
  storeId,
  root,
  kind,
  idOf = (record) => record?.id,
  revisionForPrefix = () => 1,
  maxRecords = MAX_SHARD_RECORDS,
  maxBytes = MAX_SHARD_BYTES,
} = {}) {
  assertStoreOptions({ storeId, root, kind, idOf, maxRecords, maxBytes });
  if (!Array.isArray(records)) throw codedError("VOCAB_SHARD_RECORDS_INVALID", "Vocabulary shard records must be an array.");
  if (typeof revisionForPrefix !== "function") throw new TypeError("revisionForPrefix(prefix) must be a function.");

  const ids = new Set();
  const indexed = records.map((record) => {
    const id = validateId(idOf(record));
    if (ids.has(id)) throw codedError("VOCAB_SHARD_DUPLICATE_ID", `Duplicate vocabulary record ID: ${id}`);
    ids.add(id);
    return { id, record, digest: hashText(id).slice("sha256-v1:".length) };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const output = [];
  function split(entries, prefix) {
    const revision = revisionForPrefix(prefix);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw codedError("VOCAB_SHARD_REVISION_INVALID", `Invalid revision for shard ${prefix}.`);
    }
    if (entries.length <= maxRecords) {
      const candidate = makePartition({ entries, prefix, storeId, kind, revision, maxRecords, maxBytes, root });
      if (candidate) {
        output.push(candidate);
        return;
      }
    }
    if (entries.length === 1) {
      const single = makePartition({ entries, prefix, storeId, kind, revision, maxRecords, maxBytes, root });
      if (!single) {
        throw codedError("VOCAB_SHARD_RECORD_TOO_LARGE", `Vocabulary record ${entries[0].id} exceeds the single-record shard limit.`);
      }
      output.push(single);
      return;
    }
    if (prefix.length >= 64) {
      throw codedError("VOCAB_SHARD_HASH_COLLISION", "Distinct vocabulary record IDs have the same full SHA-256 digest.");
    }
    const nextGroups = new Map();
    for (const entry of entries) {
      const nextPrefix = entry.digest.slice(0, prefix.length + 1);
      const group = nextGroups.get(nextPrefix) || [];
      group.push(entry);
      nextGroups.set(nextPrefix, group);
    }
    if (nextGroups.size === 1 && nextGroups.keys().next().value === prefix) {
      throw codedError("VOCAB_SHARD_HASH_COLLISION", "Vocabulary shard records cannot be separated by their hash prefixes.");
    }
    for (const nextPrefix of [...nextGroups.keys()].sort()) split(nextGroups.get(nextPrefix), nextPrefix);
  }

  const initialGroups = new Map();
  for (const entry of indexed) {
    const prefix = entry.digest.slice(0, 1);
    const group = initialGroups.get(prefix) || [];
    group.push(entry);
    initialGroups.set(prefix, group);
  }
  for (const prefix of [...initialGroups.keys()].sort()) split(initialGroups.get(prefix), prefix);
  output.sort((left, right) => left.prefix.localeCompare(right.prefix));
  return output;
}

function createManifest({ storeId, kind, revision, shards }) {
  return {
    schemaVersion: 1,
    kind: "vocabulary-shard-manifest",
    storeId,
    storeKind: kind,
    revision,
    shards: shards.map(({ prefix, path, value, hash, recordCount, byteLength }) => ({
      prefix,
      path,
      revision: value.revision,
      hash,
      recordCount,
      byteLength,
    })),
  };
}

function parseCanonicalSnapshot(snapshot, path, required = true) {
  if (!snapshot || typeof snapshot !== "object") throw codedError("VOCAB_SHARD_SNAPSHOT_INVALID", `Invalid snapshot for ${path}.`);
  if (!snapshot.exists) {
    if (required) throw codedError("VOCAB_SHARD_MISSING", `A manifest-referenced shard is missing: ${path}`);
    return null;
  }
  if (typeof snapshot.text !== "string") throw codedError("VOCAB_SHARD_SNAPSHOT_INVALID", `Snapshot text is missing for ${path}.`);
  let value;
  try { value = JSON.parse(snapshot.text); }
  catch { throw codedError("VOCAB_SHARD_JSON_INVALID", `Vocabulary data is malformed at ${path}.`); }
  if (canonicalStringify(value) !== snapshot.text) {
    throw codedError("VOCAB_SHARD_NONCANONICAL", `Vocabulary data is not canonical at ${path}.`);
  }
  if (snapshot.value !== undefined && canonicalStringify(snapshot.value) !== snapshot.text) {
    throw codedError("VOCAB_SHARD_SNAPSHOT_MISMATCH", `Snapshot value does not match the stored text at ${path}.`);
  }
  const actualHash = canonicalHash(value);
  if (snapshot.hash !== undefined && snapshot.hash !== actualHash) {
    throw codedError("VOCAB_SHARD_HASH_MISMATCH", `Snapshot hash does not match the stored value at ${path}.`);
  }
  if (snapshot.revision !== undefined && snapshot.revision !== value.revision) {
    throw codedError("VOCAB_SHARD_REVISION_MISMATCH", `Snapshot revision does not match the stored value at ${path}.`);
  }
  return value;
}

function snapshotMap(value) {
  if (value instanceof Map) return value;
  if (Array.isArray(value)) return new Map(value.map((item) => [item.prefix, item.snapshot || item]));
  if (value && typeof value === "object") return new Map(Object.entries(value));
  return new Map();
}

function validateManifestAndShards({
  manifestSnapshot,
  shardSnapshots,
  storeId,
  root,
  kind,
  idOf = (record) => record?.id,
  maxRecords = MAX_SHARD_RECORDS,
  maxBytes = MAX_SHARD_BYTES,
} = {}) {
  assertStoreOptions({ storeId, root, kind, idOf, maxRecords, maxBytes });
  const manifestMapPath = manifestPathFor(root);
  const manifest = parseCanonicalSnapshot(manifestSnapshot, manifestMapPath, false);
  const shardsByPrefix = snapshotMap(shardSnapshots);
  if (!manifest) {
    if (shardsByPrefix.size) throw codedError("VOCAB_SHARD_UNREFERENCED", "Shard snapshots were supplied without an active manifest.");
    return { manifest: null, records: [], shardSnapshots: new Map(), manifestSnapshot, manifestPath: manifestMapPath };
  }

  if (manifest.schemaVersion !== 1 || manifest.kind !== "vocabulary-shard-manifest" ||
      manifest.storeId !== storeId || manifest.storeKind !== kind ||
      !Number.isSafeInteger(manifest.revision) || manifest.revision < 1 || !Array.isArray(manifest.shards)) {
    throw codedError("VOCAB_SHARD_MANIFEST_INVALID", `Invalid vocabulary shard manifest at ${manifestMapPath}.`);
  }
  const active = new Map();
  let priorPrefix = "";
  const records = [];
  const allIds = new Set();
  for (const entry of manifest.shards) {
    if (!entry || typeof entry !== "object" || !HASH_PREFIX.test(entry.prefix || "") ||
        entry.path !== shardPathFor(root, entry.prefix) || !Number.isSafeInteger(entry.revision) || entry.revision < 1 ||
        !HASH_VALUE.test(entry.hash || "") || !Number.isSafeInteger(entry.recordCount) || entry.recordCount < 1 ||
        !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 1 || entry.byteLength > maxBytes) {
      throw codedError("VOCAB_SHARD_MANIFEST_ENTRY_INVALID", "The shard manifest contains an invalid reference.");
    }
    if (entry.prefix <= priorPrefix || active.has(entry.prefix)) {
      throw codedError("VOCAB_SHARD_MANIFEST_ORDER_INVALID", "Manifest shard prefixes must be unique and sorted.");
    }
    for (const previous of active.keys()) {
      if (entry.prefix.startsWith(previous) || previous.startsWith(entry.prefix)) {
        throw codedError("VOCAB_SHARD_PREFIX_OVERLAP", "Manifest shard prefixes must form a disjoint prefix-free set.");
      }
    }
    priorPrefix = entry.prefix;
    const snapshot = shardsByPrefix.get(entry.prefix);
    if (!snapshot) throw codedError("VOCAB_SHARD_MISSING", `The manifest-referenced shard ${entry.prefix} was not loaded.`);
    const value = parseCanonicalSnapshot(snapshot, entry.path, true);
    const text = snapshot.text;
    if (snapshot.revision !== entry.revision || value.revision !== entry.revision ||
        canonicalHash(value) !== entry.hash || snapshot.hash !== entry.hash ||
        utf8Length(text) !== entry.byteLength || entry.recordCount > maxRecords) {
      throw codedError("VOCAB_SHARD_REFERENCE_MISMATCH", `Manifest metadata does not match shard ${entry.prefix}.`);
    }
    if (value.schemaVersion !== 1 || value.kind !== "vocabulary-shard" || value.storeId !== storeId ||
        value.storeKind !== kind || value.prefix !== entry.prefix || !Number.isSafeInteger(value.revision) ||
        !value.records || typeof value.records !== "object" || Array.isArray(value.records)) {
      throw codedError("VOCAB_SHARD_INVALID", `Shard ${entry.prefix} has an invalid envelope.`);
    }
    const keys = Object.keys(value.records).sort();
    if (keys.length !== entry.recordCount || !keys.length) {
      throw codedError("VOCAB_SHARD_COUNT_MISMATCH", `Shard ${entry.prefix} has an invalid record count.`);
    }
    if (utf8Length(text) > maxBytes) throw codedError("VOCAB_SHARD_SIZE_LIMIT", `Shard ${entry.prefix} exceeds the byte limit.`);
    for (const id of keys) {
      validateId(id);
      const record = value.records[id];
      if (!record || typeof record !== "object" || Array.isArray(record) || validateId(idOf(record)) !== id) {
        throw codedError("VOCAB_SHARD_RECORD_ID_MISMATCH", `Shard ${entry.prefix} contains a record with a mismatched ID.`);
      }
      if (!hashText(id).slice("sha256-v1:".length).startsWith(entry.prefix)) {
        throw codedError("VOCAB_SHARD_PREFIX_MISMATCH", `Record ${id} does not belong in shard ${entry.prefix}.`);
      }
      if (allIds.has(id)) throw codedError("VOCAB_SHARD_DUPLICATE_ID", `Duplicate vocabulary record ID: ${id}`);
      allIds.add(id);
      records.push(record);
    }
    active.set(entry.prefix, snapshot);
  }
  if (shardsByPrefix.size !== active.size || [...shardsByPrefix.keys()].some((prefix) => !active.has(prefix))) {
    throw codedError("VOCAB_SHARD_UNREFERENCED", "Loaded shard snapshots do not exactly match the active manifest references.");
  }
  records.sort((left, right) => String(idOf(left)).localeCompare(String(idOf(right))));
  return { manifest, records, shardSnapshots: active, manifestSnapshot, manifestPath: manifestMapPath };
}

async function readShardedStore({
  readSnapshot,
  hasShardFiles,
  storeId,
  root,
  kind,
  idOf = (record) => record?.id,
  maxRecords = MAX_SHARD_RECORDS,
  maxBytes = MAX_SHARD_BYTES,
} = {}) {
  if (typeof readSnapshot !== "function") throw new TypeError("A vocabulary shard store requires readSnapshot(path).");
  assertStoreOptions({ storeId, root, kind, idOf, maxRecords, maxBytes });
  const manifestPath = manifestPathFor(root);
  const manifestSnapshot = await readSnapshot(manifestPath);
  const manifestValue = parseCanonicalSnapshot(manifestSnapshot, manifestPath, false);
  if (!manifestValue) {
    if (typeof hasShardFiles !== "function") {
      throw codedError("VOCAB_SHARD_DIRECTORY_PROBE_UNAVAILABLE", "A hasShardFiles(root) probe is required before treating a missing manifest as an empty store.");
    }
    let hasOrphanShardFiles;
    try { hasOrphanShardFiles = await hasShardFiles(root); }
    catch (error) {
      if (error?.code?.startsWith("VOCAB_SHARD_DIRECTORY_")) throw error;
      throw codedError("VOCAB_SHARD_DIRECTORY_PROBE_FAILED", `Could not inspect shard directory ${root}: ${error.message}`);
    }
    if (typeof hasOrphanShardFiles !== "boolean") {
      throw codedError("VOCAB_SHARD_DIRECTORY_PROBE_INVALID", `The shard directory probe for ${root} must return a boolean.`);
    }
    if (hasOrphanShardFiles) {
      throw codedError("VOCAB_SHARD_MANIFEST_MISSING", `Shard files exist without ${manifestPath}; the store is incomplete and cannot be treated as empty.`);
    }
    return validateManifestAndShards({
      manifestSnapshot, shardSnapshots: new Map(), storeId, root, kind, idOf, maxRecords, maxBytes,
    });
  }
  if (!Array.isArray(manifestValue.shards)) {
    throw codedError("VOCAB_SHARD_MANIFEST_INVALID", `Invalid vocabulary shard manifest at ${manifestPath}.`);
  }
  const shardSnapshots = new Map();
  for (const entry of manifestValue.shards) {
    if (!entry || typeof entry.prefix !== "string") {
      throw codedError("VOCAB_SHARD_MANIFEST_ENTRY_INVALID", "The shard manifest contains an invalid reference.");
    }
    const expectedPath = shardPathFor(root, entry.prefix);
    if (entry.path !== expectedPath) throw codedError("VOCAB_SHARD_PATH_MISMATCH", "A shard manifest path does not match its prefix.");
    shardSnapshots.set(entry.prefix, await readSnapshot(expectedPath));
  }
  return validateManifestAndShards({ manifestSnapshot, shardSnapshots, storeId, root, kind, idOf, maxRecords, maxBytes });
}

function sameRecords(left, right, idOf) {
  if (left.length !== right.length) return false;
  const byId = new Map(left.map((record) => [idOf(record), record]));
  for (const record of right) {
    const id = idOf(record);
    if (!byId.has(id) || canonicalStringify(byId.get(id)) !== canonicalStringify(record)) return false;
  }
  return true;
}

/**
 * Build changed-shard writes plus the manifest write. The manifest is the sole
 * active-shard set; old, unreferenced shard files are left inert and reused by
 * their deterministic prefix path if that prefix becomes active again.
 */
async function prepareShardedReplacement({
  readSnapshot,
  loaded,
  records,
  storeId,
  root,
  kind,
  idOf = (record) => record?.id,
  maxRecords = MAX_SHARD_RECORDS,
  maxBytes = MAX_SHARD_BYTES,
} = {}) {
  if (typeof readSnapshot !== "function") throw new TypeError("A vocabulary shard store requires readSnapshot(path).");
  assertStoreOptions({ storeId, root, kind, idOf, maxRecords, maxBytes });
  if (!loaded || !(loaded.shardSnapshots instanceof Map) || !Array.isArray(loaded.records)) {
    throw codedError("VOCAB_SHARD_LOADED_STATE_INVALID", "A validated loaded shard store is required.");
  }
  if (!Array.isArray(records)) throw codedError("VOCAB_SHARD_RECORDS_INVALID", "Vocabulary shard records must be an array.");

  // Candidate prefixes can change as a bucket splits. Read each fixed path at
  // most once, then repack using its actual next revision until the prefix set
  // stops changing. This keeps byte limits exact without allocating per-revision
  // filenames.
  const candidateSnapshots = new Map(loaded.shardSnapshots);
  const candidateValues = new Map();
  for (const [prefix, snapshot] of candidateSnapshots) {
    candidateValues.set(prefix, parseCanonicalSnapshot(snapshot, shardPathFor(root, prefix), true));
  }
  let partitions = [];
  for (let attempt = 0; attempt < 65; attempt += 1) {
    const revisionForPrefix = (prefix) => {
      const snapshot = candidateSnapshots.get(prefix);
      if (!snapshot?.exists) return 1;
      const prior = candidateValues.get(prefix);
      if (!prior || prior.storeId !== storeId || prior.storeKind !== kind || prior.prefix !== prefix) {
        throw codedError("VOCAB_SHARD_PATH_COLLISION", `The fixed shard path ${shardPathFor(root, prefix)} contains a different store.`);
      }
      const priorRecords = Object.values(prior.records || {});
      const nextRecords = records.filter((record) => hashText(validateId(idOf(record))).slice("sha256-v1:".length).startsWith(prefix));
      const unchanged = sameRecords(priorRecords, nextRecords, idOf);
      const revision = unchanged ? prior.revision : prior.revision + 1;
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw codedError("VOCAB_SHARD_REVISION_INVALID", `Shard ${prefix} revision exceeds the safe integer range.`);
      }
      return revision;
    };

    partitions = partitionRecords({ records, storeId, root, kind, idOf, revisionForPrefix, maxRecords, maxBytes });
    let fetched = false;
    for (const part of partitions) {
      if (candidateSnapshots.has(part.prefix)) continue;
      const snapshot = await readSnapshot(part.path);
      candidateSnapshots.set(part.prefix, snapshot);
      candidateValues.set(part.prefix, snapshot?.exists ? parseCanonicalSnapshot(snapshot, part.path, true) : null);
      fetched = true;
    }
    if (!fetched) break;
    if (attempt === 64) throw codedError("VOCAB_SHARD_REPARTITION_LIMIT", "Vocabulary shard prefixes did not stabilize.");
  }

  if (sameRecords(loaded.records, records, idOf)) {
    const sameActivePrefixes = loaded.manifest && loaded.manifest.shards.length === partitions.length &&
      loaded.manifest.shards.every((entry, index) => {
        const part = partitions[index];
        return part && entry.prefix === part.prefix && entry.path === part.path &&
          entry.revision === part.value.revision && entry.hash === part.hash &&
          entry.recordCount === part.recordCount && entry.byteLength === part.byteLength;
      });
    if (sameActivePrefixes) {
      return {
        changed: false,
        noOp: true,
        writes: [],
        deletes: [],
        manifest: loaded.manifest,
        records: loaded.records.slice(),
        previousRecords: loaded.records.slice(),
        manifestPath: manifestPathFor(root),
      };
    }
  }

  const activeByPrefix = new Map(loaded.shardSnapshots);
  const partitionByPrefix = new Map(partitions.map((part) => [part.prefix, part]));
  const writes = [];
  for (const part of partitions) {
    const snapshot = candidateSnapshots.get(part.prefix) || { exists: false, revision: 0, hash: null };
    const currentValue = candidateValues.get(part.prefix);
    if (snapshot.exists && (!currentValue || currentValue.storeId !== storeId || currentValue.storeKind !== kind || currentValue.prefix !== part.prefix)) {
      throw codedError("VOCAB_SHARD_PATH_COLLISION", `The fixed shard path ${part.path} contains a different store.`);
    }
    const recordsUnchanged = currentValue && sameRecords(Object.values(currentValue.records || {}), Object.values(part.value.records), idOf);
    const nextRevision = snapshot.exists ? (recordsUnchanged ? currentValue.revision : currentValue.revision + 1) : 1;
    const value = shardValue({ storeId, kind, prefix: part.prefix, revision: nextRevision, records: part.value.records });
    const text = canonicalStringify(value);
    const byteLength = utf8Length(text);
    if (byteLength > maxBytes || Object.keys(value.records).length > maxRecords) {
      throw codedError("VOCAB_SHARD_SIZE_LIMIT", `Shard ${part.prefix} exceeds the configured limits.`);
    }
    const hash = canonicalHash(value);
    if (snapshot.exists && snapshot.hash === hash && snapshot.text === text) continue;
    writes.push({
      path: part.path,
      storeId,
      expectedRevision: snapshot.exists ? snapshot.revision : 0,
      expectedHash: snapshot.exists ? snapshot.hash : null,
      text,
    });
    partitionByPrefix.set(part.prefix, { ...part, value, text, hash, byteLength, recordCount: Object.keys(value.records).length });
  }

  const finalPartitions = [...partitionByPrefix.values()].sort((left, right) => left.prefix.localeCompare(right.prefix));
  const oldManifest = loaded.manifest;
  const manifestReferencesUnchanged = oldManifest && oldManifest.shards.length === finalPartitions.length &&
    oldManifest.shards.every((entry, index) => {
      const part = finalPartitions[index];
      return part && entry.prefix === part.prefix && entry.path === part.path &&
        entry.revision === part.value.revision && entry.hash === part.hash &&
        entry.recordCount === part.recordCount && entry.byteLength === part.byteLength;
    });
  const manifestRevision = oldManifest ? oldManifest.revision + (manifestReferencesUnchanged ? 0 : 1) : 1;
  if (!Number.isSafeInteger(manifestRevision)) throw codedError("VOCAB_SHARD_REVISION_INVALID", "Manifest revision exceeds the safe integer range.");
  const manifest = createManifest({ storeId, kind, revision: manifestRevision, shards: finalPartitions });
  const manifestText = canonicalStringify(manifest);
  const manifestSnapshot = loaded.manifestSnapshot || { exists: false, revision: 0, hash: null };
  const oldManifestText = manifestSnapshot.exists ? manifestSnapshot.text : null;
  const manifestChanged = oldManifestText !== manifestText;
  if (manifestChanged) {
    writes.push({
      path: manifestPathFor(root),
      storeId,
      expectedRevision: manifestSnapshot.exists ? manifestSnapshot.revision : 0,
      expectedHash: manifestSnapshot.exists ? manifestSnapshot.hash : null,
      text: manifestText,
    });
  }
  const noOp = writes.length === 0;
  return {
    changed: !noOp,
    noOp,
    writes,
    deletes: [],
    manifest,
    records: records.slice().sort((left, right) => String(idOf(left)).localeCompare(String(idOf(right)))),
    previousRecords: loaded.records.slice(),
    manifestPath: manifestPathFor(root),
  };
}

function createShardedStore(options = {}) {
  const { transaction, hasShardFiles: injectedHasShardFiles, ...config } = options;
  if (!transaction || typeof transaction.readSnapshot !== "function") {
    throw new TypeError("A vocabulary shard store requires a transaction coordinator with readSnapshot().");
  }
  const idOf = config.idOf || ((record) => record?.id);
  assertStoreOptions({
    storeId: config.storeId,
    root: config.root,
    kind: config.kind,
    idOf,
    maxRecords: config.maxRecords ?? MAX_SHARD_RECORDS,
    maxBytes: config.maxBytes ?? MAX_SHARD_BYTES,
  });
  const fixed = { ...config, idOf };
  const hasShardFiles = injectedHasShardFiles || ((root) => hasShardFilesFromAdapter(transaction.adapter, root));
  async function load() {
    return readShardedStore({ readSnapshot: (path) => transaction.readSnapshot(path), hasShardFiles, ...fixed });
  }
  async function prepare(records) {
    const loaded = await load();
    const plan = await prepareShardedReplacement({
      readSnapshot: (path) => transaction.readSnapshot(path), loaded, records, ...fixed,
    });
    return { loaded, ...plan };
  }
  async function commit({ actionId, records, historySummary = null, entities = [] } = {}) {
    const plan = await prepare(records);
    if (plan.noOp) return { status: "unchanged", ...plan };
    if (typeof transaction.commit !== "function") throw new TypeError("The transaction coordinator does not expose commit().");
    const result = await transaction.commit({ actionId, writes: plan.writes, deletes: plan.deletes, historySummary, entities });
    return { ...result, plan };
  }
  return Object.freeze({ ...fixed, manifestPath: manifestPathFor(fixed.root), load, prepare, commit });
}

module.exports = {
  VOCABULARY_DATA_ROOT,
  MAX_SHARD_RECORDS,
  MAX_SHARD_BYTES,
  manifestPathFor,
  shardPathFor,
  partitionRecords,
  createManifest,
  validateManifestAndShards,
  hasShardFilesFromListing,
  hasShardFilesFromAdapter,
  readShardedStore,
  prepareShardedReplacement,
  createShardedStore,
};
