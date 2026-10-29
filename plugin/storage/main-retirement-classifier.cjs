/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const { canonicalJson } = require("./canonical.cjs");
const { validateOperation } = require("./merge-engine.cjs");
const { verifyMainSnapshotCandidate } = require("./main-snapshot-candidate.cjs");

// This classifies evidence only. The caller must independently establish a
// durable, authorized retirement fence; this function cannot retire a device,
// write a file, or authorize garbage collection.
async function classifyRetiredOperations({ document, checkpoint, deviceId, throughSeq, operations, hash } = {}) {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(deviceId || "") || !Number.isSafeInteger(throughSeq) || throughSeq < 0 ||
      !Array.isArray(operations) || typeof hash !== "function") throw new TypeError("A device, fence and operations are required.");
  const verified = await verifyMainSnapshotCandidate({ document, snapshotId: checkpoint?.snapshotId, value: checkpoint?.value, hash });
  const winners = new Map(verified.operations.filter((row) => row.version.deviceId === deviceId)
    .map((row) => [row.opId, canonicalJson(row)]));
  const receipts = new Map(verified.receipts.filter((row) => row.deviceId === deviceId && row.version)
    .map((row) => [canonicalJson([row.uuid, row.originOpId]), row]));
  const active = [], covered = [], quarantined = [];
  for (const input of operations) {
    const operation = validateOperation(input);
    if (operation.version.deviceId !== deviceId) { active.push(input); continue; }
    if (operation.seq > throughSeq) { quarantined.push(input); continue; }
    let exact = winners.get(operation.opId) === canonicalJson(operation);
    if (!exact && operation.uuid && operation.originOpId) {
      const receipt = receipts.get(canonicalJson([operation.uuid, operation.originOpId]));
      const timestampCovered = operation.type === "ANNOTATION_SET" ? operation.deletedAt === undefined :
        operation.type === "ANNOTATION_DELETE" && Number.isSafeInteger(receipt?.deletedAt) && receipt.deletedAt === operation.deletedAt;
      if (timestampCovered && receipt?.opId === operation.opId && canonicalJson(receipt.version) === canonicalJson(operation.version)) {
        const { seq, version, opId, deletedAt, ...userInput } = operation;
        exact = receipt.inputHash === await hash(new TextEncoder().encode(canonicalJson(userInput)));
      }
    }
    (exact ? covered : quarantined).push(input);
  }
  return { active, covered, quarantined };
}
module.exports = { classifyRetiredOperations };
