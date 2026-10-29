/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const RETIRE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// This records local observations, not Sync completion or a retirement
// certificate. The retirement protocol must independently prove membership,
// pending contributions, checkpoint acknowledgements and safe cleanup.
function observeDevice(previous, { digest, now } = {}) {
  if (!/^sha256-v1:[a-f0-9]{64}$/.test(digest || "") || !Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("A device observation requires a SHA-256 digest and a valid local time.");
  }
  if (previous) {
    if (!/^sha256-v1:[a-f0-9]{64}$/.test(previous.digest || "") ||
        !Number.isSafeInteger(previous.firstObservedAt) || !Number.isSafeInteger(previous.lastObservedAt) ||
        previous.firstObservedAt < 0 || previous.lastObservedAt < previous.firstObservedAt) {
      throw new TypeError("Invalid prior device observation.");
    }
    if (now < previous.lastObservedAt) return { ...previous, clockUncertain: true };
    if (previous.clockUncertain === true) {
      // An interval spanning a clock rollback cannot establish seven days of
      // continuous inactivity, even after the wall clock catches up again.
      return { digest, firstObservedAt: now, lastObservedAt: now, clockUncertain: false };
    }
    if (digest === previous.digest) {
      return { digest, firstObservedAt: previous.firstObservedAt, lastObservedAt: now, clockUncertain: false };
    }
  }
  return { digest, firstObservedAt: now, lastObservedAt: now, clockUncertain: false };
}

function isRetirementCandidate(observation, now) {
  return Boolean(observation && observation.clockUncertain === false && Number.isSafeInteger(now) &&
    /^sha256-v1:[a-f0-9]{64}$/.test(observation.digest || "") && now >= 0 &&
    Number.isSafeInteger(observation.firstObservedAt) && Number.isSafeInteger(observation.lastObservedAt) &&
    observation.firstObservedAt >= 0 &&
    now === observation.lastObservedAt && observation.lastObservedAt >= observation.firstObservedAt &&
    now - observation.firstObservedAt >= RETIRE_AFTER_MS);
}

module.exports = { RETIRE_AFTER_MS, observeDevice, isRetirementCandidate };
