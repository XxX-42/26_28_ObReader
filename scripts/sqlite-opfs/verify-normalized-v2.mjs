#!/usr/bin/env node
// Hash the same compact, sorted NFC/lower/space-normalized JSONL serialization
// that resource-v2 uses, then compare it to the byte-for-byte SQLite readback.
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { normalizeDictionaryKey } = require("../../plugin/vocabulary/dictionary-resource.cjs");
const [resource, reportPath] = process.argv.slice(2);
if (!resource || !reportPath) throw new Error("Usage: node verify-normalized-v2.mjs <resource.jsonl.gz> <fixture-report.json>");
const report = JSON.parse(await readFile(reportPath, "utf8"));
const digest = createHash("sha256");
const lines = createInterface({ input: createReadStream(path.resolve(resource)).pipe(createGunzip()), crlfDelay: Infinity });
let count = 0;
let previousKey = "";
for await (const line of lines) {
  assert.ok(line.length > 0, `empty resource row ${count + 1}`);
  const row = JSON.parse(line);
  assert.deepEqual(Object.keys(row), ["key", "translation", "phonetic"], `field order/shape at row ${count + 1}`);
  assert.equal(typeof row.translation, "string", `translation type at row ${count + 1}`);
  assert.equal(typeof row.phonetic, "string", `phonetic type at row ${count + 1}`);
  const key = normalizeDictionaryKey(row.key);
  assert.equal(key, row.key, `key does not satisfy resource-v2 normalization at row ${count + 1}`);
  assert.ok(key > previousKey, `keys are not strictly sorted at row ${count + 1}`);
  previousKey = key;
  const normalizedJsonl = `${JSON.stringify({ key, translation: row.translation, phonetic: row.phonetic })}\n`;
  assert.equal(normalizedJsonl, `${line}\n`, `row differs from canonical resource-v2 serialization at row ${count + 1}`);
  digest.update(normalizedJsonl, "utf8");
  count += 1;
}
const logicalNormalizedSha256 = digest.digest("hex");
assert.equal(count, 770611, "resource-v2 row count");
assert.equal(report.entryCount, count, "SQLite fixture row count");
assert.equal(report.readbackJsonlSha256, logicalNormalizedSha256,
  "all ordered SQLite row_json values must equal the canonical normalized resource-v2 JSONL");
assert.equal(report.integrityCheck, "ok", "SQLite integrity check");
report.normalization = "nfc-lower-space-v1";
report.logicalNormalizedSha256 = logicalNormalizedSha256;
report.fullRecordEquivalence = {
  method: "SQLite row_json readback in ordinal order hashes to the v2 canonical compact JSONL; every key is checked with plugin normalizeDictionaryKey and every field/field order is checked.",
  rows: count,
  verified: true,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ entryCount: count, logicalNormalizedSha256, equivalent: true }, null, 2));
