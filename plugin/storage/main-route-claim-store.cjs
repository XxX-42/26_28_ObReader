/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const { canonicalJson } = require("./canonical.cjs");
const { normalizeInitialPath, validateFullSourceHash } = require("./document-identity.cjs");
const { validateOperation } = require("./merge-engine.cjs");
const { createStorageIo } = require("./io.cjs");
const error = (message) => Object.assign(new Error(message), { code: "MAIN_ROUTE_CLAIM_INVALID" });

// Claims are discovery hints until their route and identity are checked
// against verified WAL/checkpoint state. Missing claims are not proof that a
// device, a route or a concurrent identity does not exist.
function createMainRouteClaimStore({ adapter, root, hash, token, deviceId }) {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(deviceId || "")) throw error("Invalid reporter identity.");
  const io = createStorageIo({ adapter, hash, token });
  const sha = async (value) => {
    const id = await hash(new TextEncoder().encode(value));
    if (!/^sha256-v1:[a-f0-9]{64}$/.test(id || "")) throw error("SHA-256 is required.");
    return id.slice(10);
  };
  const directory = async (path) => `${root}/main-routes/${await sha(normalizeInitialPath(path))}`;
  function validate(value, indexedPath, reporter) {
    if (!value || value.schemaVersion !== 1 || value.kind !== "pdf-reader-main-route-claim" ||
        value.indexedPath !== indexedPath || value.reporter !== reporter ||
        !/^[a-f0-9]{12}$/.test(value.docKey || "") || typeof value.documentId !== "string" || !value.documentId) {
      throw error("Route claim identity differs.");
    }
    validateFullSourceHash(value.sourceHash);
    const route = validateOperation(value.route);
    if (route.type !== "ROUTE_SET" || !route.payload.source ||
        route.payload.source.sourceHash !== value.sourceHash) throw error("Route claim source differs.");
    return value;
  }
  async function publish({ indexedPath, document, route }) {
    const path = normalizeInitialPath(indexedPath);
    const value = { schemaVersion: 1, kind: "pdf-reader-main-route-claim", indexedPath: path,
      reporter: deviceId, docKey: document?.docKey, documentId: document?.documentId,
      sourceHash: document?.source?.sourceHash, route };
    validate(value, path, deviceId);
    const digest = await sha(canonicalJson(value));
    const target = `${await directory(path)}/${deviceId}/${value.docKey}.${digest}.json`;
    const previous = await io.readJson(target, { validate: (row) => validate(row, path, deviceId) });
    if (previous) {
      if (canonicalJson(previous) !== canonicalJson(value)) throw error("Route claim digest collision.");
      return { path: target, value: previous };
    }
    await io.writeJsonAtomic(target, value, { createOnly: true, validate: (row) => validate(row, path, deviceId) });
    return { path: target, value };
  }
  async function query(indexedPath) {
    const path = normalizeInitialPath(indexedPath), base = await directory(path), claims = [], errors = [];
    if (!(await adapter.exists(base))) return { claims, errors };
    for (const folder of (await adapter.list(base)).folders.sort()) {
      const reporter = folder.slice(folder.lastIndexOf("/") + 1);
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(reporter)) { errors.push({ path: folder, code: "MAIN_ROUTE_CLAIM_INVALID" }); continue; }
      for (const file of (await adapter.list(folder)).files.sort()) {
        const match = /\/([a-f0-9]{12})\.([a-f0-9]{64})\.json$/.exec(file);
        if (!match) {
          if (/\.json\.pending-[A-Za-z0-9_-]+$/.test(file) && await io.verifiedDuplicateStage(file)) continue;
          if (/\.json\.pending(?:-[A-Za-z0-9_-]+)?$/.test(file)) errors.push({ path: file, code: "MAIN_ROUTE_CLAIM_PENDING" });
          else if (/\.json$/.test(file)) errors.push({ path: file, code: "MAIN_ROUTE_CLAIM_INVALID" });
          continue;
        }
        try {
          const value = await io.readJson(file, { validate: (row) => validate(row, path, reporter) });
          if (!value || value.docKey !== match[1] || await sha(canonicalJson(value)) !== match[2]) throw error("Route claim filename differs.");
          claims.push(value);
        } catch (cause) { errors.push({ path: file, code: cause.code || "MAIN_ROUTE_CLAIM_INVALID" }); }
      }
    }
    return { claims, errors };
  }
  return Object.freeze({ directory, publish, query });
}
module.exports = { createMainRouteClaimStore };
