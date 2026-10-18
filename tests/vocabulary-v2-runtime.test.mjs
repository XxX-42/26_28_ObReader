import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { VocabularyMemoryAdapter } from "./vocabulary-v2-memory-adapter.mjs";
const require = createRequire(import.meta.url);
const { VocabularyService, VOCABULARY_PATH } = require("../plugin/vocabulary/service.cjs");
const { createVocabularyRuntime } = require("../plugin/vocabulary/runtime.cjs");

function fixture(adapter = new VocabularyMemoryAdapter(), prefix = "first") {
  let sequence = 0;
  const service = new VocabularyService({ adapter, now: () => 1000 });
  const timers = new Map();
  const runtime = createVocabularyRuntime({ adapter, personalService: service, deviceId: "local-device-one",
    sessionId: `${prefix}-plugin-session`, now: () => 1000,
    makeId: () => `${prefix}-id-${++sequence}`,
    verifySource: async ({ anchor }) => ({ status: "verified", sourceCurrent: true, pageCurrent: true, anchor }),
    setTimeout: (callback) => { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id) });
  return { adapter, service, runtime, timers };
}

test("workspace is lazy, core writes have reversible history, and PDF queries touch no new stores", async () => {
  const { adapter, service, runtime } = fixture();
  assert.equal(adapter.files.size, 0);
  assert.equal((await runtime.close()).status, "noop");
  await runtime.mutatePersonal((vocabulary) => vocabulary.upsertTerm("walk", { status: 2, translation: "步行" }));
  await runtime.mutatePersonal((vocabulary) => vocabulary.setNote("walk", "first note"));
  const batches = await runtime.history.listBatches();
  assert.equal(batches.length, 2);
  adapter.resetMetrics();
  const matched = await service.matchPageTokens(["walking", "home"]);
  assert.equal(matched.wordMatches[0].status, 2);
  assert.equal(adapter.measured().readBytes, 0);
  assert.equal(adapter.measured().writtenBytes, 0);
  const noteBatch = batches.find((batch) => batch.changes.some((change) => change.fieldPath.at(-1) === "note"));
  assert.ok(noteBatch);
  assert.equal((await runtime.restore(noteBatch.batchId)).status, "committed");
  assert.equal((await service.getTerm("walk")).note, undefined);
  await runtime.close();
  assert.ok([...adapter.files.keys()].every((file) => file.startsWith("00_Archive/21_VocabularyData/")));
});

function contextInput(familyKey) {
  const hash = "sha256-v1:" + "a".repeat(64);
  return { familyKey, surface: "walk", sentence: "We walk home.", anchor: {
    schemaVersion: 1, kind: "obreader-selection-anchor", anchorId: "selection-race-one", documentId: "stable-doc",
    docKey: "012345abcdef", sourceHash: hash, pageIdentity: "page-one", pageIndexHint: 0,
    pageCount: 1, orderedPageIdentityDigest: hash, textPosition: { start: 3, end: 7 }, exactQuote: "walk",
    prefix: "We ", suffix: " home.", geometry: null,
  } };
}

test("family deletion rechecks reference evidence if another workspace saves a Context after preview", async () => {
  const first = fixture();
  await first.runtime.mutatePersonal((service) => service.upsertTerm("walk", { status: 2 }));
  const family = await first.service.getFamily("walk");
  const creation = (await first.runtime.history.listBatches())[0];
  const second = fixture(first.adapter, "second");
  await second.runtime.ready();
  const commit = first.runtime.coordinator.commit.bind(first.runtime.coordinator);
  let inserted = false;
  first.runtime.coordinator.commit = async (input) => {
    if (input.historySummary?.kind === "restore" && !inserted) {
      inserted = true;
      assert.equal((await second.runtime.saveContext(contextInput(family.familyKey))).status, "committed");
    }
    return commit(input);
  };
  const result = await first.runtime.restore(creation.batchId);
  assert.equal(inserted, true);
  assert.equal(result.status, "conflict", "stale absence evidence cannot authorize family deletion");
  assert.ok(await first.service.getFamily("walk"));
  assert.equal((await second.runtime.contexts.load()).records.length, 1);
  await first.runtime.close();
  await second.runtime.close();
});

test("Context commit refuses a family deleted after its lookup in another workspace", async () => {
  const first = fixture();
  await first.runtime.mutatePersonal((service) => service.upsertTerm("walk", { status: 2 }));
  const family = await first.service.getFamily("walk");
  const creation = (await first.runtime.history.listBatches())[0];
  const second = fixture(first.adapter, "second");
  await second.runtime.ready();
  const commit = second.runtime.coordinator.commit.bind(second.runtime.coordinator);
  let removed = false;
  second.runtime.coordinator.commit = async (input) => {
    if (input.entities?.some((entity) => entity.storeId === second.runtime.contexts.storeId) && !removed) {
      removed = true;
      assert.equal((await first.runtime.restore(creation.batchId)).status, "committed");
    }
    return commit(input);
  };
  const result = await second.runtime.saveContext(contextInput(family.familyKey));
  assert.equal(removed, true);
  assert.equal(result.status, "conflict");
  assert.equal((await second.runtime.contexts.load()).records.length, 0);
  await second.service.reload();
  assert.equal(await second.service.getFamily("walk"), undefined);
  await first.runtime.close();
  await second.runtime.close();
});

test("acknowledged review actions recover before a new session and never rewrite the vocabulary", async () => {
  const first = fixture();
  await first.runtime.mutatePersonal((vocabulary) => vocabulary.upsertTerm("walk", { status: 2 }));
  const family = await first.service.getFamily("walk");
  const review = await first.runtime.ensureReviewSession();
  await review.enroll(family.familyKey, { actionId: "enroll-walk" });
  first.adapter.resetMetrics();
  await review.remember(family.familyKey, { actionId: "remember-walk" });
  const ratingIo = first.adapter.measured();
  const coreBytes = first.adapter.files.get(VOCABULARY_PATH);
  assert.equal(ratingIo.writes, 0, "one rating does not rewrite canonical Review or vocabulary snapshots");
  assert.equal(ratingIo.appends, 1, "one acknowledged rating appends only to the bounded local session journal");
  assert.ok(ratingIo.writtenBytes < 64 * 1024, "one rating writes less than one bounded journal segment");
  assert.equal(ratingIo.filesTouched.length, 1);
  assert.match(ratingIo.filesTouched[0], /^00_Archive\/21_VocabularyData\/transactions\/local-device-one\//);
  assert.ok(!ratingIo.filesTouched.includes(VOCABULARY_PATH));
  assert.ok(!ratingIo.filesTouched.some((file) => file.startsWith("00_Archive/21_VocabularyData/review/states/")));
  const priorSession = review.getStatus().sessionId;
  // Simulated process termination: all timers/memory vanish; disk is retained.
  first.timers.clear();
  const second = fixture(first.adapter, "second");
  const reopened = await second.runtime.ensureReviewSession();
  const restored = await reopened.getState(family.familyKey);
  assert.equal(restored.box, 2);
  assert.equal(restored.reviewCount, 1);
  assert.equal(first.adapter.files.get(VOCABULARY_PATH), coreBytes);
  const histories = await second.runtime.history.listBatches();
  assert.equal(histories.filter((batch) => batch.batchId === `review-final:${priorSession}`).length, 1);
  await second.runtime.close();
});

test("concurrent and repeated controlled close share one Review finalization", async () => {
  const current = fixture();
  await current.runtime.mutatePersonal((service) => service.upsertTerm("walk", { status: 2 }));
  const family = await current.service.getFamily("walk");
  const review = await current.runtime.ensureReviewSession();
  await review.enroll(family.familyKey, { actionId: "close-race-enroll" });
  await review.remember(family.familyKey, { actionId: "close-race-remember" });

  const results = await Promise.all([current.runtime.close(), current.runtime.close(), current.runtime.close()]);
  assert.deepEqual(results.map((result) => result.status), ["closed", "closed", "closed"]);
  const batches = await current.runtime.history.listBatches();
  assert.equal(batches.filter((batch) => batch.batchId === `review-final:${review.getStatus().sessionId}`).length, 1);
  assert.equal(review.getStatus().closed, true);
  assert.equal((await current.runtime.close()).status, "closed", "a later close is idempotent too");
});

test("a torn native Review append can retry, finalize, and stay closed when a new runtime ensures its session", async () => {
  class TornAppendAdapter extends VocabularyMemoryAdapter {
    constructor() {
      super();
      this.failNextAppend = false;
    }
    async append(path, text) {
      if (!this.failNextAppend) return super.append(path, text);
      this.failNextAppend = false;
      const torn = text.slice(0, Math.max(1, Math.floor(text.length / 2)));
      this.files.set(path, `${this.files.get(path) || ""}${torn}`);
      throw new Error("injected runtime torn append");
    }
  }

  const adapter = new TornAppendAdapter();
  const first = fixture(adapter, "torn-runtime");
  await first.runtime.mutatePersonal((vocabulary) => vocabulary.upsertTerm("walk", { status: 2 }));
  const family = await first.service.getFamily("walk");
  const review = await first.runtime.ensureReviewSession();
  const priorSession = review.getStatus().sessionId;
  await review.enroll(family.familyKey, { actionId: "torn-runtime-enroll" });

  adapter.failNextAppend = true;
  await assert.rejects(
    review.remember(family.familyKey, { actionId: "torn-runtime-remember" }),
    /injected runtime torn append/,
  );
  const interrupted = await first.runtime.coordinator.readJournalActions(priorSession);
  assert.deepEqual(interrupted.actions.map(({ actionId }) => actionId), ["torn-runtime-enroll"]);
  assert.equal(interrupted.recoveryEvidence.length, 1);
  const damagedJournalText = interrupted.segments.find((segment) => segment.damaged).text;
  await review.remember(family.familyKey, { actionId: "torn-runtime-remember" });

  const closed = await review.close();
  assert.equal(closed.status, "closed");
  const transactionFolder = `00_Archive/21_VocabularyData/transactions/local-device-one/${priorSession}`;
  const sessionFiles = [...adapter.files.keys()].filter((path) => path.startsWith(`${transactionFolder}/`));
  assert.equal(sessionFiles.filter((path) => /review-\d{6}\.jsonl$/.test(path)).length, 0,
    "finalization removes every active journal segment after the final History batch verifies");
  assert.equal(sessionFiles.filter((path) => /review-\d{6}\.jsonl\.evidence-[a-f0-9]+$/.test(path)).length, 1,
    "the original torn bytes survive under a non-active evidence name");
  const evidencePath = sessionFiles.find((path) => /review-\d{6}\.jsonl\.evidence-[a-f0-9]+$/.test(path));
  assert.equal(adapter.files.get(evidencePath), damagedJournalText);
  assert.equal((await first.runtime.history.listBatches()).filter((batch) => batch.batchId === `review-final:${priorSession}`).length, 1);

  const second = fixture(adapter, "torn-runtime-restart");
  const ensured = await second.runtime.ensureReviewSession();
  assert.notEqual(ensured.getStatus().sessionId, priorSession);
  assert.equal(ensured.getStatus().actionCount, 0);
  assert.deepEqual(await second.runtime.recoverReviewSessions(), [], "evidence-only old sessions are not replayed");
  assert.deepEqual((await second.runtime.coordinator.readJournalActions(priorSession)).actions, []);
  await first.runtime.close();
  await second.runtime.close();
});

test("runtime reloads personal state after recovering a core transaction before coordinator attachment", async () => {
  const first = fixture();
  await first.runtime.mutatePersonal((service) => service.upsertTerm("walk", { status: 2 }));
  let crashed = false;
  first.adapter.hook = async ({ phase, operation, to }) => {
    if (!crashed && phase === "before" && operation === "rename" && to === VOCABULARY_PATH) {
      crashed = true;
      throw new Error("crash before canonical core install");
    }
  };
  await assert.rejects(first.runtime.mutatePersonal((service) => service.setNote("walk", "durable recovered note")));
  assert.equal(crashed, true);
  first.adapter.hook = null;
  const restarted = fixture(first.adapter, "restarted-core");
  await restarted.service.ready(); // startup may already have read the pre-recovery snapshot
  await restarted.runtime.ready();
  assert.equal((await restarted.service.getTerm("walk")).note, "durable recovered note");
  await restarted.runtime.mutatePersonal((service) => service.setTranslation("walk", "恢复后可继续写入"));
  assert.equal((await restarted.service.getTerm("walk")).translation, "恢复后可继续写入");
  await restarted.runtime.close();
});
