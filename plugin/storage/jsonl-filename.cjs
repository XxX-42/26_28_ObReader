/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

// The date belongs to the JSONL pair and must remain stable on subsequent
// saves and PDF renames. It is a local calendar date, not a content hash.
function localDateSuffix(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError('A valid date is required.');
  const two = value => String(value).padStart(2, '0');
  return `${two(date.getFullYear() % 100)}${two(date.getMonth() + 1)}${two(date.getDate())}`;
}
function datedJsonlStem(sourcePath, suffix) {
  if (typeof sourcePath !== 'string' || !/\.pdf$/i.test(sourcePath) || !/^\d{6}$/.test(suffix)) throw new TypeError('A PDF path and YYMMDD suffix are required.');
  return `${sourcePath.slice(0, -4)}${suffix}`;
}
module.exports = { localDateSuffix, datedJsonlStem };
