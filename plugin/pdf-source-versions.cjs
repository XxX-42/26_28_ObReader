/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const { sha256 } = require("@noble/hashes/sha256");
const sha256Hex = (bytes) => Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
const { canonicalJson } = require("./storage/canonical.cjs");
const { createStorageIo } = require("./storage/io.cjs");
const VERSION = "outline-incremental-v1";
function createSourceVersions({ adapter, makeToken, root = "00_Archive/20_PDFData" }) {
  const io = createStorageIo({ adapter, hash: (bytes) => "sha256-v1:" + sha256Hex(bytes), token: makeToken });
  async function record(document, proof) {
    if (proof?.status !== "VERIFIED" || proof.verifierVersion !== VERSION || proof.beforeHash !== document.source?.sourceHash || proof.beforeSize !== document.source?.size || !/^sha256-v1:[a-f0-9]{64}$/.test(proof.afterHash) || !/^[a-f0-9]{12}$/.test(document.docKey)) throw Error("Invalid verified source version");
    const value = { schemaVersion: 1, kind: "pdf-reader-outline-source-version", documentId: document.documentId, docKey: document.docKey, verifierVersion: VERSION, before: { sourceHash: proof.beforeHash, size: proof.beforeSize }, after: { sourceHash: proof.afterHash, size: proof.afterSize }, pageCount: proof.pageCount, orderedPageIdentities: proof.orderedPageIdentities, revisions: proof.revisions };
    const path = `${root}/source-versions/${document.docKey}/${proof.afterHash.slice(10)}.json`;
    const validate = (current) => {
      if (canonicalJson(current) !== canonicalJson(value)) throw Object.assign(Error("Source version record differs from verified PDF"), { code: "PDF_SOURCE_VERSION_CONFLICT" });
    };
    if (await adapter.exists(path) || await adapter.exists(path + ".pending")) {
      await io.readJson(path, { validate });
      return { path, value };
    }
    await io.ensureDirectory(path);
    await io.writeJsonAtomic(path, value, { validate });
    await io.readJson(path, { validate });
    return { path, value };
  }
  return { record };
}
module.exports = { createSourceVersions };
