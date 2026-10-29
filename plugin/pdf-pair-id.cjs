/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const { PDFDocument, PDFDict, PDFName, PDFString, PDFHexString } = require('pdf-lib');
const { captureIncrementalSnapshot, createIncrementalPatch, materializeIncrementalResult } = require('./pdf-incremental.cjs');
const PAIR_ID = /^[a-f0-9]{32}$/;
const key = PDFName.of('ObReaderPairId');
const fail = (code, message) => Object.assign(new Error(message), { code });
function validatePairId(id) {
  if (typeof id !== 'string' || !PAIR_ID.test(id)) throw fail('PDF_PAIR_ID_INVALID', 'Pair ID must contain 32 lowercase hexadecimal characters.');
  return id;
}
function generatePairId(random = globalThis.crypto) {
  if (typeof random?.getRandomValues !== 'function') throw fail('PDF_PAIR_ID_RANDOM_UNAVAILABLE', 'A cryptographic random source is required.');
  const bytes = new Uint8Array(16); random.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}
function infoPairId(pdf) {
  const info = pdf.context.lookup(pdf.context.trailerInfo.Info);
  if (!info) return null;
  if (!(info instanceof PDFDict)) throw fail('PDF_PAIR_ID_INVALID', 'Invalid PDF Info dictionary.');
  const value = info.get(key);
  if (value === undefined) return null;
  if (!(value instanceof PDFString || value instanceof PDFHexString)) throw fail('PDF_PAIR_ID_INVALID', 'Invalid pair identity metadata.');
  return validatePairId(value.decodeText());
}
async function load(bytes) {
  let pdf;
  try { pdf = await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch (cause) { throw Object.assign(fail('PDF_PAIR_ID_UNSUPPORTED', 'Cannot safely parse this PDF.'), { cause }); }
  if (pdf.isEncrypted) throw fail('PDF_PAIR_ID_UNSUPPORTED', 'Encrypted PDFs cannot receive an identity.');
  return pdf;
}
async function readPairId(bytes) { return infoPairId(await load(bytes)); }
async function ensurePairId(sourceBytes, pairId) {
  if (pairId !== undefined && pairId !== null) validatePairId(pairId);
  const original = sourceBytes instanceof Uint8Array ? sourceBytes : new Uint8Array(sourceBytes);
  const pdf = await load(original), existing = infoPairId(pdf);
  if (existing) {
    if (pairId && existing !== pairId) throw fail('PDF_PAIR_ID_CONFLICT', 'PDF already belongs to a different annotation file.');
    return { changed: false, pairId: existing, bytes: original, changedObjectCount: 0 };
  }
  pairId ||= generatePairId();
  if (pdf.catalog.has(PDFName.of('Perms'))) throw fail('PDF_PAIR_ID_UNSUPPORTED', 'A permission signature prevents metadata changes.');
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && (object.get(PDFName.of('Type')) === PDFName.of('Sig') || object.get(PDFName.of('FT')) === PDFName.of('Sig'))) {
      throw fail('PDF_PAIR_ID_UNSUPPORTED', 'Signed PDFs are not modified.');
    }
  }
  const snapshot = captureIncrementalSnapshot({ sourceBytes: original, document: pdf });
  const previousInfo = pdf.context.lookup(pdf.context.trailerInfo.Info);
  const nextInfo = PDFDict.withContext(pdf.context);
  if (previousInfo instanceof PDFDict) for (const [name, value] of previousInfo.entries()) nextInfo.set(name, value);
  nextInfo.set(key, PDFString.of(pairId));
  pdf.context.trailerInfo.Info = pdf.context.register(nextInfo);
  const patch = createIncrementalPatch({ sourceBytes: original, document: pdf, snapshot, allowInfoChange: true });
  if (!patch || patch.changedObjectCount !== 1) throw fail('PDF_PAIR_ID_UNVERIFIED', 'Identity update changed more than the Info dictionary.');
  const { bytes } = materializeIncrementalResult({ sourceBytes: original, patch });
  if (await readPairId(bytes) !== pairId) throw fail('PDF_PAIR_ID_UNVERIFIED', 'Cannot verify the persisted identity.');
  return { changed: true, pairId, bytes, changedObjectCount: patch.changedObjectCount };
}
async function attachPairId(sourceBytes, pairId) {
  validatePairId(pairId);
  return ensurePairId(sourceBytes, pairId);
}
async function appendPairUpdate(vault, file, expectedBytes) {
  if (typeof vault?.readBinary !== 'function' || typeof vault?.appendBinary !== 'function')
    throw fail('PDF_PAIR_APPEND_UNAVAILABLE', 'The Vault cannot append binary PDF updates safely.');
  const expected = expectedBytes instanceof Uint8Array ? expectedBytes : new Uint8Array(expectedBytes);
  const current = new Uint8Array(await vault.readBinary(file));
  if (expected.length <= current.length) throw fail('PDF_PAIR_SOURCE_CHANGED', 'The PDF no longer matches the prepared incremental update.');
  for (let i=0;i<current.length;i++) if(current[i]!==expected[i])
    throw fail('PDF_PAIR_SOURCE_CHANGED', 'The PDF no longer matches the prepared incremental update.');
  const suffix=expected.subarray(current.length);
  await vault.appendBinary(file, suffix.buffer.slice(suffix.byteOffset,suffix.byteOffset+suffix.byteLength));
}
module.exports = { generatePairId, validatePairId, readPairId, attachPairId, ensurePairId, appendPairUpdate };
