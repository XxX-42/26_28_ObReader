"use strict";

const { VocabularyTransactionCoordinator } = require("./transactions.cjs");
const { VocabularyHistory } = require("./history.cjs");
const { createVocabularyContextService } = require("./context-service.cjs");
const { createVocabularyReviewService, createReviewHistoryRestoreHandler, REVIEW_ROOT, REVIEW_STORE_ID, REVIEW_KIND } = require("./review-service.cjs");
const { createShardedStore } = require("./sharded-store.cjs");

// Constructed lazily by explicit learning actions. PDF page matching keeps its
// existing personal VocabularyService and never calls into this workspace.
function createVocabularyRuntime({ adapter, personalService, deviceId, sessionId,
  verifySource, now = () => Date.now(), makeId = () => globalThis.crypto.randomUUID(),
  setTimeout, clearTimeout } = {}) {
  if (!personalService || typeof personalService.attachCoordinator !== "function") {
    throw new TypeError("Vocabulary workspace requires the existing personal service.");
  }
  const coordinator = new VocabularyTransactionCoordinator({ adapter, deviceId, sessionId, now, makeId });
  const history = new VocabularyHistory({ coordinator, makeId });
  const contexts = createVocabularyContextService({ transaction: coordinator, vocabularyService: personalService,
    verifySource: verifySource || (async () => ({ status: "unverified", sourceCurrent: false, pageCurrent: false })), now });
  const review = createVocabularyReviewService({ transaction: coordinator, vocabularyService: personalService, now, makeId,
    ...(setTimeout ? { setTimeout } : {}), ...(clearTimeout ? { clearTimeout } : {}) });
  const reviewStore = createShardedStore({ transaction: coordinator, root: REVIEW_ROOT, storeId: REVIEW_STORE_ID,
    kind: REVIEW_KIND, idOf: (record) => record.familyKey });
  history.registerStoreHandler(REVIEW_STORE_ID, createReviewHistoryRestoreHandler({ transaction: coordinator, vocabularyService: personalService }));
  let initialization = null;
  let serial = Promise.resolve();
  let recoveryPromise = null;
  let reviewOpening = null;

  async function validateReferences(_candidate, { removedFamilyKeys = [] } = {}) {
    if (!removedFamilyKeys.length) return true;
    const removed = new Set(removedFamilyKeys);
    const [contextState, reviewState] = await Promise.all([contexts.load(), reviewStore.load()]);
    if (contextState.records.some((record) => removed.has(record.familyKey)) ||
        reviewState.records.some((record) => removed.has(record.familyKey))) {
      throw Object.assign(new Error("该词族仍被语境或复习记录引用，不能恢复为不存在的状态。"), { code: "vocabulary-restore-reference-conflict" });
    }
    const preconditions = [];
    for (const [storeId, loaded] of [[contexts.storeId, contextState], [REVIEW_STORE_ID, reviewState]]) {
      const manifest = loaded.manifestSnapshot;
      preconditions.push({ storeId, path: loaded.manifestPath,
        expectedRevision: manifest.exists ? manifest.revision : 0, expectedHash: manifest.exists ? manifest.hash : null });
      for (const entry of loaded.manifest?.shards || []) {
        const snapshot = loaded.shardSnapshots.get(entry.prefix);
        preconditions.push({ storeId, path: entry.path, expectedRevision: snapshot.revision, expectedHash: snapshot.hash });
      }
    }
    return { ok: true, preconditions };
  }

  async function ready() {
    if (initialization) return initialization;
    const pending = (async () => {
      await personalService.ready();
      await personalService.migrate();
      const recovery = await coordinator.recoverLocal();
      // Conflicts retain their own store scope. The corresponding operation
      // checks them before writing; an unrelated pending cannot lock all data.
      await personalService.attachCoordinator(coordinator, { validateReferences });
      return { recovery };
    })();
    initialization = pending;
    try { return await pending; }
    catch (error) { if (initialization === pending) initialization = null; throw error; }
  }

  function exclusive(task) {
    const pending = serial.then(async () => { await ready(); return task(); });
    serial = pending.catch(() => undefined);
    return pending;
  }

  async function recoverReviewSessions() {
    await ready();
    if (recoveryPromise) return recoveryPromise;
    const pending = (async () => {
      const directory = `00_Archive/21_VocabularyData/transactions/${deviceId}`;
      if (!(await adapter.exists(directory))) return [];
      const listing = await adapter.list(directory);
      const recovered = [];
      for (const folder of [...(listing.folders || [])].sort()) {
        const localSession = folder.slice(directory.length + 1);
        if (!folder.startsWith(`${directory}/`) || !/^[A-Za-z0-9_-]{1,128}$/.test(localSession)) continue;
        if (review.getStatus()?.sessionId === localSession && !review.getStatus().closed) continue;
        const files = await adapter.list(folder);
        const needsRecovery = files.files?.some((file) => {
          const name = file.slice(folder.length + 1);
          return name === "summary.pending.json" || /^review-\d{6}(?:\.segment\.json(?:\.backup)?|\.jsonl)$/.test(name);
        });
        if (!needsRecovery) continue;
        await review.openSession({ sessionId: localSession });
        await review.close();
        recovered.push(localSession);
      }
      return recovered;
    })();
    recoveryPromise = pending;
    try { return await pending; }
    finally { if (recoveryPromise === pending) recoveryPromise = null; }
  }

  async function ensureReviewSession() {
    if (reviewOpening) return reviewOpening;
    const pending = (async () => {
      await recoverReviewSessions();
      const status = review.getStatus();
      if (!status || status.closed) await review.openSession({ sessionId: makeId() });
      return review;
    })();
    reviewOpening = pending;
    try { return await pending; }
    finally { if (reviewOpening === pending) reviewOpening = null; }
  }

  async function restore(batchId, options) {
    return exclusive(async () => {
      await recoverReviewSessions();
      if (review.getStatus() && !review.getStatus().closed) await review.close();
      const result = await history.restore(batchId, options);
      if (result.status === "committed") await personalService.reload();
      return result;
    });
  }

  async function close() {
    // A workspace which was never opened has no state to flush and must not
    // create files merely because the plugin is unloading.
    if (!initialization) return { status: "noop" };
    await serial;
    if (reviewOpening) await reviewOpening;
    await ready();
    if (review.getStatus() && !review.getStatus().closed) await review.close();
    await personalService.flush();
    return { status: "closed" };
  }

  return Object.freeze({ coordinator, history, contexts, review, personalService, ready, ensureReviewSession, recoverReviewSessions,
    mutatePersonal: (task) => exclusive(() => task(personalService)),
    saveContext: (input) => exclusive(() => contexts.saveContext(input)),
    restore, close, validateReferences, exclusive });
}

module.exports = { createVocabularyRuntime };
