/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

// A lease is acquired before creating PDF-sized snapshots, then before the
// Vault write queue. Borrowers keep it alive through the host's final cleanup.
function createHeavyWorkCoordinator({ enabled, makeId }) {
  let active = null;
  let disposed = false;
  const waiting = [];
  const error = (message) => Object.assign(new Error(message), { code: "PDF_HEAVY_SESSION_CHANGED" });
  const noop = () => ({ id: null, release() {} });

  function finish(entry) {
    if (active !== entry || !entry.releaseRequested || entry.borrowers) return;
    active = null;
    pump();
  }
  function pump() {
    if (disposed || active) return;
    while (waiting.length) {
      const entry = waiting.shift();
      if (!entry.valid()) { entry.reject(error("PDF changed while waiting for its save slot.")); continue; }
      active = entry;
      entry.resolve({ id: entry.id, release() { entry.releaseRequested = true; finish(entry); } });
      return;
    }
  }
  function acquire(owner, context, { requestId = null, valid = () => true } = {}) {
    if (disposed) return Promise.reject(error("PDF work coordinator is disposed."));
    if (!enabled()) return Promise.resolve(noop());
    return new Promise((resolve, reject) => {
      waiting.push({ id: makeId(), owner, context, requestId, valid, resolve, reject, borrowers: 0, releaseRequested: false });
      pump();
    });
  }
  function borrow(owner, context, id) {
    if (!enabled()) return noop();
    const entry = active;
    if (disposed || !entry || entry.releaseRequested || entry.id !== id || entry.owner !== owner ||
        entry.context.file !== context.file || entry.context.documentId !== context.documentId ||
        entry.context.openRequest !== context.openRequest || entry.context.rendererGeneration !== context.rendererGeneration || !entry.valid()) {
      throw error("The PDF save slot belongs to another document or Reader.");
    }
    entry.borrowers += 1;
    let released = false;
    return { id, release() { if (released) return; released = true; entry.borrowers -= 1; finish(entry); } };
  }
  function cancel(owner, requestId = null) {
    for (let index = waiting.length - 1; index >= 0; index--) {
      const entry = waiting[index];
      if (entry.owner !== owner || (requestId && entry.requestId !== requestId)) continue;
      waiting.splice(index, 1);
      entry.reject(error("PDF work request was cancelled."));
    }
    // A cancellation may race the grant message. Host borrowers prevent an
    // early unlock if serialization has already reached the host.
    // Host-owned inspect/reconcile jobs have no requestId and may still be
    // parsing after a Reader closes. Their finally block releases the slot.
    if (active?.owner === owner && active.requestId && (!requestId || active.requestId === requestId)) {
      active.releaseRequested = true;
      finish(active);
    }
  }
  function cancelQueued(owner, { requestId = null, reason = null } = {}) {
    let cancelledCount = 0;
    for (let index = waiting.length - 1; index >= 0; index--) {
      const entry = waiting[index];
      if (entry.owner !== owner || (requestId !== null && entry.requestId !== requestId) ||
          (reason !== null && entry.context?.reason !== reason)) continue;
      waiting.splice(index, 1);
      entry.reject(error("PDF work request was cancelled."));
      cancelledCount += 1;
    }
    return cancelledCount;
  }
  function release(owner, id) {
    if (active?.owner !== owner || active.id !== id) return false;
    active.releaseRequested = true;
    finish(active);
    return true;
  }
  function dispose() {
    disposed = true;
    for (const entry of waiting.splice(0)) entry.reject(error("PDF work coordinator is disposed."));
    if (active) { active.releaseRequested = true; finish(active); }
  }
  return { acquire, borrow, cancel, cancelQueued, release, dispose };
}

module.exports = { createHeavyWorkCoordinator };
