/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

const { canonicalJson } = require("./canonical.cjs");
const { joinOperations, validateOperation } = require("./merge-engine.cjs");
const { deriveDocumentIdentity, validateFullSourceHash } = require("./document-identity.cjs");

const IMPORT_DEVICE_ID = "legacy-import";
const FORMAT3_EXPORT_KIND = "pdf-annotation-format3-migration-export";

/**
 * Creates a one-shot importer from the old Format 3 annotation store into the
 * sealed sidecar format. The importer retains only each UUID's current winner
 * and a routing operation; it does not copy old operation clocks, batch ids,
 * parents, ACKs, checkpoints, or covered-batch history.
 *
 * `persistBaseline(identity, sidecar)` is the host hook that seeds the current
 * device WAL anchor from the verified sidecar. It is run on both first import
 * and a repeated import of an already-existing equivalent sidecar.
 */
function createFormat3Importer({ legacyStore, sidecarStore, stableHash, persistBaseline } = {}) {
  if (!sidecarStore || typeof sidecarStore.loadSidecar !== "function" ||
      typeof sidecarStore.writeSidecar !== "function") {
    throw new TypeError("A sidecar store with loadSidecar and writeSidecar is required.");
  }
  if (typeof stableHash !== "function") throw new TypeError("A stable identity hash function is required.");
  if (persistBaseline !== undefined && typeof persistBaseline !== "function") {
    throw new TypeError("persistBaseline must be a function when provided.");
  }

  async function getExport(sourcePathOrExport) {
    if (isMigrationExport(sourcePathOrExport)) return sourcePathOrExport;
    if (!legacyStore || typeof legacyStore.exportForMigration !== "function") {
      throw new TypeError("A Format 3 store with exportForMigration is required.");
    }
    return legacyStore.exportForMigration(sourcePathOrExport);
  }

  async function prepareImport(sourcePathOrExport) {
    const exported = await getExport(sourcePathOrExport);
    validateMigrationExport(exported);
    const initialPath = exported.document.sourcePath;
    const fullSourceHash = validateFullSourceHash(exported.document.source.sourceHash);
    const identity = await deriveDocumentIdentity({ initialPath, fullSourceHash, stableHash });
    const source = stableSourceMetadata(exported.document.source);
    const operations = await makeImportOperations(exported, identity, stableHash, source);
    const sidecar = {
      schemaVersion: 1,
      kind: "pdf-reader-materialized-sidecar",
      document: {
        documentId: identity.documentId,
        docKey: identity.docKey,
        initialPath: identity.initialPath,
        fullSourceHash: identity.fullSourceHash,
        sourcePath: exported.document.sourcePath,
        source,
        legacyIdentities: cloneJson(exported.legacyIdentities),
        legacyIdentityScanComplete: exported.legacyIdentityScanComplete === true,
      },
      operations,
      watermark: {},
    };
    const expectedState = joinOperations(operations);
    return { identity, sidecar, expectedState };
  }

  function verifySemantic(existing, prepared) {
    if (!existing || typeof existing !== "object" ||
        existing.schemaVersion !== 1 || existing.kind !== "pdf-reader-materialized-sidecar" ||
        !Array.isArray(existing.operations) || !existing.document || typeof existing.document !== "object") {
      throw importConflict("The existing sidecar has no valid operation state; refusing to replace it.");
    }
    let actualState;
    try {
      for (const operation of existing.operations) validateOperation(operation);
      actualState = joinOperations(existing.operations);
    } catch (error) {
      throw importConflict("The existing sidecar operation state is invalid; refusing to replace it.", error);
    }
    const expectedState = prepared.expectedState || joinOperations(prepared.sidecar.operations);
    if (canonicalJson(operationState(actualState)) !== canonicalJson(operationState(expectedState))) {
      throw importConflict("The existing sidecar has different effective annotation or routing state.");
    }
    const metadataKeys = [
      "documentId", "docKey", "initialPath", "fullSourceHash", "sourcePath", "source",
      "legacyIdentities", "legacyIdentityScanComplete",
    ];
    for (const key of metadataKeys) {
      if (semanticJson(existing.document[key]) !== semanticJson(prepared.sidecar.document[key])) {
        throw importConflict(`The existing sidecar document.${key} differs from the Format 3 migration state.`);
      }
    }
    return true;
  }

  async function importDocument(sourcePathOrExport) {
    if (typeof persistBaseline !== "function") {
      throw new TypeError("importDocument requires persistBaseline so the new WAL anchor is seeded before success.");
    }
    const prepared = await prepareImport(sourcePathOrExport);
    const existing = await sidecarStore.loadSidecar(prepared.identity);
    if (existing) {
      verifySemantic(existing, prepared);
      await persistBaseline(prepared.identity, existing);
      return { identity: prepared.identity, sidecar: existing, imported: false, duplicate: true };
    }

    let written;
    try {
      written = await sidecarStore.writeSidecar(prepared.identity, prepared.sidecar, { createOnly: true });
    } catch (error) {
      if (!new Set(["WAL_SIDECAR_EXISTS", "PDF_WAL_SIDECAR_EXISTS"]).has(error?.code)) throw error;
      const raced = await sidecarStore.loadSidecar(prepared.identity);
      if (!raced) throw error;
      verifySemantic(raced, prepared);
      written = raced;
    }
    const verified = written || await sidecarStore.loadSidecar(prepared.identity);
    if (!verified) throw importConflict("The new sidecar could not be read back after import.");
    verifySemantic(verified, prepared);
    await persistBaseline(prepared.identity, verified);
    return { identity: prepared.identity, sidecar: verified, imported: true, duplicate: false };
  }

  return Object.freeze({ prepareImport, verifySemantic, importDocument });
}

async function makeImportOperations(exported, identity, stableHash, source) {
  const version = { rev: 1, deviceId: IMPORT_DEVICE_ID, seq: 0 };
  const rows = [
    ...exported.snapshot.annotations.map((row) => ({ ...row, deleted: false })),
    ...exported.snapshot.tombstones.map((row) => ({ ...row, deleted: true })),
  ].sort((left, right) => compareString(left.uuid, right.uuid));
  const operations = [];
  for (const row of rows) {
    const type = row.deleted ? "ANNOTATION_DELETE" : "ANNOTATION_SET";
    const opDigest = String(await stableHash(new TextEncoder().encode(
      `pdf-reader-wal-v1:legacy-import:${type}:${row.uuid}`,
    ))).toLowerCase();
    const operation = {
      type,
      uuid: row.uuid,
      seq: 0,
      opId: `legacy-import:${opDigest}`,
      version: { ...version },
      kind: row.kind,
      pageIndex: row.pageIndex,
      ...(row.deleted !== true ? { payload: cloneJson(row.payload) } : {}),
      ...(row.embeddedRef !== undefined ? { embeddedRef: row.embeddedRef } : {}),
    };
    validateOperation(operation);
    operations.push(operation);
  }
  const routing = {
    type: "ROUTE_SET",
    seq: 0,
    opId: "legacy-import:route",
    version: { ...version },
    payload: {
      initialPath: identity.initialPath,
      sourcePath: exported.document.sourcePath,
      source: cloneJson(source),
      sourceHash: identity.fullSourceHash,
      documentId: identity.documentId,
      docKey: identity.docKey,
    },
  };
  validateOperation(routing);
  operations.push(routing);
  return operations;
}

function stableSourceMetadata(value) {
  const source = cloneJson(value);
  // Filesystem modification times are local observations, not document
  // identity. Keeping them here made otherwise identical one-shot baselines
  // differ across devices and caused needless sidecar conflicts.
  for (const key of ["mtime", "mtimeMs", "modifiedAt", "lastModified", "createdAt", "updatedAt"]) {
    delete source[key];
  }
  return source;
}

function validateMigrationExport(value) {
  if (!isMigrationExport(value) || !value.document || typeof value.document !== "object" ||
      !value.snapshot || !Array.isArray(value.snapshot.annotations) ||
      !Array.isArray(value.snapshot.tombstones) || !Array.isArray(value.legacyIdentities) ||
      !value.routing || typeof value.routing !== "object" ||
      !value.document.source || typeof value.document.source !== "object" ||
      typeof value.document.sourcePath !== "string") {
    throw importConflict("The Format 3 export is incomplete; refusing to import partial state.");
  }
  const seen = new Set();
  for (const row of [...value.snapshot.annotations, ...value.snapshot.tombstones]) {
    if (!row || typeof row.uuid !== "string" || seen.has(row.uuid)) {
      throw importConflict("The Format 3 export contains an ambiguous effective UUID set.");
    }
    seen.add(row.uuid);
  }
  if (value.snapshot.annotations.some((row) => row.deleted === true) ||
      value.snapshot.tombstones.some((row) => row.deleted !== true)) {
    throw importConflict("The Format 3 export has inconsistent live and deleted rows.");
  }
}

function isMigrationExport(value) {
  return Boolean(value && value.kind === FORMAT3_EXPORT_KIND && value.schemaVersion === 1);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function semanticJson(value) {
  return value === undefined ? "undefined" : canonicalJson(value);
}

function operationState(state) {
  const stripVersion = (operation) => {
    if (!operation) return null;
    const semantic = { ...operation };
    delete semantic.version;
    delete semantic.seq;
    delete semantic.opId;
    return semantic;
  };
  const annotations = {};
  const tombstones = {};
  for (const [uuid, operation] of Object.entries(state.annotations || {})) {
    annotations[uuid] = stripVersion(operation);
  }
  for (const [uuid, operation] of Object.entries(state.tombstones || {})) {
    tombstones[uuid] = stripVersion(operation);
  }
  return {
    annotations,
    tombstones,
    routing: stripVersion(state.routing),
  };
}

function compareString(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function importConflict(message, cause) {
  const error = Object.assign(new Error(message), { code: "PDF_FORMAT3_IMPORT_CONFLICT" });
  if (cause !== undefined) error.cause = cause;
  return error;
}

module.exports = { createFormat3Importer };
