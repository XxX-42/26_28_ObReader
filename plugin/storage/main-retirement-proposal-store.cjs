/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const { canonicalJson } = require("./canonical.cjs");
const { createStorageIo } = require("./io.cjs");
const { makeRetirementProposal } = require("./main-retirement-proposal.cjs");
const invalid = (message) => Object.assign(new Error(message), { code: "MAIN_RETIREMENT_INVALID" });

// Immutable planning evidence only: these records are never retirement
// fences, never authorize deletion, and must be revalidated against live state.
function createRetirementProposalStore({ adapter, root, hash, token, snapshots }) {
  const io = createStorageIo({ adapter, hash, token });
  function pathFor(document, id) {
    if (!/^[a-f0-9]{12}$/.test(document?.docKey || "") || !/^sha256-v1:[a-f0-9]{64}$/.test(id || "")) {
      throw invalid("Invalid proposal identity.");
    }
    return `${root}/main-retirement-proposals/${document.docKey}/${id.slice(10)}.json`;
  }
  async function validate(document, value) {
    if (!value || value.docKey !== document.docKey || value.documentId !== document.documentId ||
        value.sourceHash !== document.source?.sourceHash) throw invalid("Proposal document identity differs.");
    const checkpoint = await snapshots.read(document, value.checkpointId);
    if (!checkpoint) throw invalid("Proposal checkpoint is unavailable.");
    // The synthetic ACKs validate structure only; a proposal read does not
    // assert that the actual ACK files or device membership are still valid.
    const acknowledgements = Array.isArray(value.deviceIds) ? value.deviceIds.filter((id) => id !== value.deviceId)
      .map((deviceId) => ({ deviceId, snapshotId: value.checkpointId, verified: true })) : [];
    const rebuilt = await makeRetirementProposal({ document, checkpoint, deviceId: value.deviceId, observerId: value.observerId,
      now: value.observedAt, presenceDigest: value.presenceDigest,
      observation: { digest: value.presenceDigest, firstObservedAt: value.observedSince, lastObservedAt: value.observedAt, clockUncertain: false },
      deviceIds: value.deviceIds, acknowledgements, hash });
    if (canonicalJson(value) !== canonicalJson(rebuilt)) throw invalid("Proposal content differs from its verified checkpoint.");
  }
  async function read(document, id) {
    const path = pathFor(document, id);
    let value;
    try { value = await io.readJson(path, { validate: (row) => validate(document, row) }); }
    catch (error) {
      if (error?.cause?.code === "MAIN_RETIREMENT_INVALID") throw error.cause;
      throw error;
    }
    if (!value) return null;
    const actual = await hash(new TextEncoder().encode(canonicalJson(value)));
    if (actual !== id) throw invalid("Proposal identity does not match its contents.");
    return { id, path, value };
  }
  async function publish(document, value) {
    await validate(document, value);
    const id = await hash(new TextEncoder().encode(canonicalJson(value)));
    const path = pathFor(document, id);
    const existing = await read(document, id);
    if (existing) return existing;
    try { await io.writeJsonAtomic(path, value, { uniquePending: true, createOnly: true, validate: (row) => validate(document, row) }); }
    catch (error) {
      if (error.code !== "WAL_SIDECAR_EXISTS") throw error;
    }
    const result = await read(document, id);
    if (!result) throw invalid("Proposal publication could not be verified.");
    return result;
  }
  return { pathFor, read, publish };
}
module.exports = { createRetirementProposalStore };
