/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

function codedError(code, message) {
  const error = new Error(message);
  error.name = "WalSidecarError";
  error.code = code;
  return error;
}

function isSafeString(value, maxLength = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
    value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function validateVersion(version) {
  if (!version || typeof version !== "object" || Array.isArray(version)) {
    throw codedError("WAL_VERSION_INVALID", "An operation version must be an object.");
  }
  const { rev, deviceId, seq } = version;
  if (!Number.isSafeInteger(rev) || rev <= 0 ||
      !isSafeString(deviceId) ||
      !Number.isSafeInteger(seq) || seq < 0) {
    throw codedError("WAL_VERSION_INVALID", "Version needs a positive safe rev, safe deviceId, and non-negative safe seq.");
  }
  return { rev, deviceId, seq };
}

function compareVersion(left, right) {
  const a = validateVersion(left);
  const b = validateVersion(right);
  if (a.rev !== b.rev) return a.rev < b.rev ? -1 : 1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return 0;
}

module.exports = {
  validateVersion,
  compareVersion,
  isSafeString,
};
