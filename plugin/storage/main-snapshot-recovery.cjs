/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const { canonicalJson } = require("./canonical.cjs");
const { joinOperations } = require("./merge-engine.cjs");
const { createStorageIo } = require("./io.cjs");
const { coveredByCheckpointPair } = require("./main-snapshot-maintenance.cjs");
const { containsReceipts } = require("./main-snapshot-candidate.cjs");
const fail = (message) => Object.assign(new Error(message), { code: "MAIN_RECOVERY_INVALID" });

function createMainRecoveryStore({ adapter, root, hash, token, snapshots }) {
  const io = createStorageIo({ adapter, hash, token });
  const directory = (document) => {
    if (!/^[a-f0-9]{12}$/.test(document?.docKey || "")) throw fail("Invalid document key.");
    return `${root}/main-recovery/${document.docKey}`;
  };
  async function validate(document, record) {
    if (!record || record.schemaVersion !== 1 || record.kind !== "pdf-reader-main-recovery" ||
        record.docKey !== document.docKey || record.documentId !== document.documentId ||
        !/^((sha256-v1:[a-f0-9]{64})|(xxh64-v1:[a-f0-9]{16}))$/.test(record.sourceHash || "") ||
        (document.source?.sourceHash && record.sourceHash !== document.source.sourceHash) ||
        !Array.isArray(record.archives) || !record.archives.length || !Array.isArray(record.devices) ||
        !Array.isArray(record.acknowledgements)) throw fail("Invalid recovery certificate.");
    if (record.supersedes !== undefined && (!Array.isArray(record.supersedes) ||
        record.supersedes.some((id) => !/^sha256-v1:[a-f0-9]{64}$/.test(id)) ||
        new Set(record.supersedes).size !== record.supersedes.length)) throw fail("Invalid superseded certificates.");
    const identity = { ...document, source: { ...(document.source || {}), sourceHash: record.sourceHash } };
    const current = await snapshots.read(identity, record.current);
    const previous = await snapshots.read(identity, record.previous);
    if (!current || !previous || !current.value.parents.includes(previous.snapshotId)) throw fail("Recovery checkpoint pair is incomplete.");
    if (current.value.segments.some((segment) => !record.devices.includes(segment.deviceId))) {
      throw fail("A checkpoint participant is absent from the acknowledgement roster.");
    }
    const state = joinOperations(current.value.operations);
    if (canonicalJson(joinOperations(current.value.operations, previous.value.operations)) !== canonicalJson(state)) {
      throw fail("Current checkpoint omits previous state.");
    }
    if (!containsReceipts(current.value, previous.value)) throw fail("Current checkpoint omits prior operation receipts.");
    for (const archive of record.archives) {
      const owner = archive.deviceId;
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(owner || "") ||
          archive.path !== `${root}/wal/${owner}/${document.docKey}.jsonl.archive.${archive.firstSeq}-${archive.lastSeq}.json` ||
          !coveredByCheckpointPair({ current, previous, archive, activeDeviceIds: record.devices,
            acknowledgements: record.acknowledgements })) throw fail("Archive deletion evidence differs.");
    }
    return { record, current, previous, state };
  }
  async function publish(document, record) {
    await validate(document, record);
    const id = await hash(new TextEncoder().encode(canonicalJson(record)));
    if (!/^sha256-v1:[a-f0-9]{64}$/.test(id)) throw fail("SHA-256 is required.");
    const path = `${directory(document)}/${id.slice(10)}.json`;
    const existing = await io.readJson(path);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(record)) throw fail("Recovery hash collision.");
    } else await io.writeJsonAtomic(path, record, { createOnly: true });
    return { path, id, ...(await validate(document, await io.readJson(path))) };
  }
  async function read(document) {
    const dir = directory(document);
    const records = [], errors = [];
    if (!(await adapter.exists(dir))) return { records, errors };
    for (const path of (await adapter.list(dir)).files.sort()) {
      if (/\/[a-f0-9]{64}\.json\.pending-[A-Za-z0-9_-]+$/.test(path) && await io.verifiedDuplicateStage(path)) continue;
      if (/\/[a-f0-9]{64}\.json\.(?:gc-[A-Za-z0-9_-]+|pending(?:-[A-Za-z0-9_-]+)?)$/.test(path)) {
        errors.push({ path, code: "MAIN_RECOVERY_PENDING", message: "Interrupted recovery operation requires inspection." });
        continue;
      }
      const match = /\/([a-f0-9]{64})\.json$/.exec(path);
      if (!match) continue;
      try {
        const record = await io.readJson(path);
        const id = await hash(new TextEncoder().encode(canonicalJson(record)));
        if (id !== `sha256-v1:${match[1]}`) throw fail("Recovery filename differs from its contents.");
        records.push({ path, id, ...(await validate(document, record)) });
      } catch (error) { errors.push({ path, id: `sha256-v1:${match[1]}`, code: error.code || "MAIN_RECOVERY_INVALID", message: error.message }); }
    }
    // A valid cumulative certificate makes its named predecessors obsolete,
    // including stale copies later restored by Sync. An invalid newer record
    // can never suppress an older recovery witness.
    const superseded = new Set(records.flatMap((entry) => entry.record.supersedes || []));
    return { records: records.filter((entry) => !superseded.has(entry.id)),
      errors: errors.filter((entry) => !superseded.has(entry.id)) };
  }
  return { publish, read };
}
module.exports = { createMainRecoveryStore };
