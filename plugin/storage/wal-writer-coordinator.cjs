/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

// Module-level WeakMap means every store factory in this JavaScript realm
// shares the same queue for an adapter/device/document tuple.
const queuesByAdapter = new WeakMap();

function createWalWriterCoordinator() {
  async function run(adapter, deviceId, docKey, operation) {
    if (!adapter || (typeof adapter !== "object" && typeof adapter !== "function")) {
      throw new TypeError("A DataAdapter object is required for WAL coordination.");
    }
    if (typeof deviceId !== "string" || !deviceId || typeof docKey !== "string" || !docKey) {
      throw new TypeError("WAL coordination requires a deviceId and docKey.");
    }
    if (typeof operation !== "function") throw new TypeError("A queued WAL operation must be a function.");

    let queues = queuesByAdapter.get(adapter);
    if (!queues) {
      queues = new Map();
      queuesByAdapter.set(adapter, queues);
    }
    const key = `${deviceId.length}:${deviceId}${docKey.length}:${docKey}`;
    const previous = queues.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    queues.set(key, settled);

    try {
      return await result;
    } finally {
      if (queues.get(key) === settled) {
        queues.delete(key);
        if (queues.size === 0) queuesByAdapter.delete(adapter);
      }
    }
  }

  return Object.freeze({ run });
}

const sharedCoordinator = createWalWriterCoordinator();

module.exports = {
  createWalWriterCoordinator,
  createCoordinator: createWalWriterCoordinator,
  runQueuedWalWrite: sharedCoordinator.run,
};
