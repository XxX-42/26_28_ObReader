/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

const { canonicalJson } = require("./canonical.cjs");
const { joinOperations } = require("./merge-engine.cjs");

function codedError(code, message) {
  const error = new Error(message);
  error.name = "WalSidecarError";
  error.code = code;
  return error;
}

function isOperation(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof value.type === "string");
}

function collectSources(value, output, label) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    if (value.length === 0 || value.every(isOperation)) {
      output.push(value);
      return;
    }
    for (const item of value) collectSources(item, output, label);
    return;
  }
  if (isOperation(value)) {
    output.push([value]);
    return;
  }
  if (typeof value === "object" && Array.isArray(value.operations)) {
    output.push(value);
    return;
  }
  throw codedError("WAL_EFFECTIVE_SOURCE_INVALID", `${label} must contain operations or records with an operations array.`);
}

function buildEffectiveState({ sidecar, anchors = [], tails = [] } = {}) {
  const sources = [];
  collectSources(sidecar, sources, "sidecar");
  collectSources(anchors, sources, "anchors");
  collectSources(tails, sources, "tails");
  return joinOperations(...sources);
}

function effectiveStatesEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

module.exports = {
  buildEffectiveState,
  effectiveStatesEqual,
};
