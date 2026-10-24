import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { VocabularyMemoryAdapter } from "./vocabulary-v2-memory-adapter.mjs";

const require = createRequire(import.meta.url);
const { VocabularyTransactionCoordinator } = require("../plugin/vocabulary/transactions.cjs");
const { VocabularyHistory } = require("../plugin/vocabulary/history.cjs");
const { createVocabularyReviewService } = require("../plugin/vocabulary/review-service.cjs");
const {
  LEARNING_ROOT,
  LEARNING_STORE_ID,
  createLearningService,
} = require("../plugin/learning/service.cjs");
const { LeitnerScheduler, LEITNER_INTERVAL_DAYS } = require("../plugin/learning/scheduler.cjs");
const {
  LEARNING_ASSISTANT_CAPABILITIES,
  createDeterministicLearningProvider,
  createDraftWithProvider,
} = require("../plugin/learning/provider.cjs");

const SOURCE = Object.freeze({
  target: { kind: "annotation", id: "annotation-1" },
  documentId: "doc-1",
  docKey: "a".repeat(12),
  sourcePath: "Library/Book.pdf",
  sourceHash: "b".repeat(64),
  pageIndex: 1,
  pageIdentity: "page:2",
  targetText: "embody the principle",
  targetTextSource: "captured",
});
function markdownSource(sourcePath, { offset = 5, text = "quoted words", line = 1 } = {}) {
  return {
    target: { kind: "markdown", id: `md:${offset}:${offset + text.length}` },
    documentId: null, docKey: null, sourcePath, sourceHash: null, pageIndex: null, pageIdentity: null,
    targetText: text, targetTextSource: "captured", evidenceKind: "markdown",
    sourceRange: { startOffset: offset, endOffset: offset + text.length, line, text },
  };
}

function createFixture({ adapter = new VocabularyMemoryAdapter(), initialTime = "2026-10-22T10:00:00.000Z", deviceId = "learning-domain-device" } = {}) {
  let id = 0;
  let currentTime = initialTime;
  let sourceVerified = true;
  const coordinator = new VocabularyTransactionCoordinator({
    adapter,
    deviceId,
    sessionId: "learning-domain-session",
    now: () => Date.parse(currentTime),
    makeId: () => `tx-${++id}`,
  });
  const history = new VocabularyHistory({ coordinator, makeId: () => `history-${++id}` });
  let serial = Promise.resolve();
  const runtime = {
    coordinator,
    history,
    exclusive(task) {
      const result = serial.then(task);
      serial = result.catch(() => undefined);
      return result;
    },
  };
  let serviceId = 0;
  const createService = () => createLearningService({
    runtime,
    verifySource: async (source) => sourceVerified
      ? { status: "verified", sourceCurrent: true, pageCurrent: true, anchor: source }
      : { status: "stale", sourceCurrent: false, pageCurrent: false, anchor: source },
    now: () => new Date(currentTime),
    makeId: () => `id-${++serviceId}`,
  });
  return {
    adapter, coordinator, history, runtime, createService,
    setTime(value) { currentTime = value; },
    setSourceVerified(value) { sourceVerified = value; },
  };
}

async function confirm(service, { source = SOURCE, prompt = "What does it mean?", answer, actionId = "confirm-1" } = {}) {
  const draft = service.createDraft({ source, prompt, answer });
  return service.confirmDraft(draft.draftId, { actionId });
}

test('learning rejects a PDF source which cannot use the existing Reader identity protocol', () => {
  const f=createFixture(),service=f.createService();
  assert.throws(()=>service.createDraft({source:{...SOURCE,docKey:'a'.repeat(64)},prompt:'Question'}),
    error=>error.code==='LEARNING_SOURCE_INVALID');
  assert.equal(f.adapter.files.size,0);
});

test("Draft cancellation performs no writes; confirmation is idempotent and allows multiple items per source", async () => {
  const fixture = createFixture();
  const service = fixture.createService();
  const initial = fixture.adapter.measured();
  const cancelled = service.createDraft({ source: SOURCE, prompt: "Question?" });
  assert.equal(cancelled.answer, SOURCE.targetText, "answer defaults to captured targetText");
  assert.deepEqual(fixture.adapter.measured(), initial, "draft creation is memory-only");
  assert.equal(service.cancelDraft(cancelled.draftId).writes, 0);
  assert.deepEqual(fixture.adapter.measured(), initial, "cancellation is zero-write");

  const first = service.createDraft({ source: SOURCE, prompt: "Question one?" });
  service.updateDraft(first.draftId, { answer: "A manually edited answer" });
  const committed = await service.confirmDraft(first.draftId, { actionId: "confirm-one" });
  assert.equal(committed.status, "committed");
  assert.equal(committed.item.answer, "A manually edited answer");
  assert.equal(committed.item.externalId, `obreader-learning:v1:${committed.item.itemId.slice("learning:v1:".length)}`);
  assert.equal(fixture.adapter.measured().writes > 0, true);
  const afterFirst = fixture.adapter.measured().writes;
  const duplicateDraft = service.createDraft({ source: SOURCE, prompt: "Question one?", answer: "A manually edited answer" });
  const duplicate = await service.confirmDraft(duplicateDraft.draftId, { actionId: "confirm-one" });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.item.itemId, committed.item.itemId);
  assert.equal(fixture.adapter.measured().writes, afterFirst, "same confirm action does not write again");

  const second = await confirm(service, { prompt: "A second question?", actionId: "confirm-two" });
  assert.equal(second.status, "committed");
  assert.equal(second.item.source.target.id, committed.item.source.target.id);
  assert.notEqual(second.item.itemId, committed.item.itemId, "one source can create multiple learning items");
  assert.equal((await service.exportItems("json")).itemCount, 2);
});

test("A stale source leaves the editable draft intact and source deletion never deletes a saved item", async () => {
  const fixture = createFixture();
  const service = fixture.createService();
  const draft = service.createDraft({ source: SOURCE, prompt: "Explain this" });
  service.updateDraft(draft.draftId, { answer: "Keep this answer" });
  const writesBefore = fixture.adapter.measured().writes;
  fixture.setSourceVerified(false);
  await assert.rejects(service.confirmDraft(draft.draftId, { actionId: "stale-confirm" }),
    (error) => error.code === "LEARNING_SOURCE_STALE");
  assert.equal(service.getDraft(draft.draftId).answer, "Keep this answer");
  assert.equal(fixture.adapter.measured().writes, writesBefore, "stale confirmation does not write");

  fixture.setSourceVerified(true);
  const saved = await service.confirmDraft(draft.draftId, { actionId: "valid-confirm" });
  fixture.setSourceVerified(false);
  assert.equal((await service.getItem(saved.item.itemId)).itemId, saved.item.itemId);
  assert.equal((await service.listDue()).items.length, 1, "source disappearance does not delete the card or due state");
});

test("skip lasts only for one review session and reset is memory-only", async () => {
  const fixture = createFixture();
  const service = fixture.createService();
  const saved = await confirm(service, { actionId: "session-skip-confirm" });
  const writesBeforeSkip = fixture.adapter.measured().writes;
  const batchesBeforeSkip = await fixture.history.listBatches({ deviceIds: [fixture.coordinator.deviceId] });

  const skipped = await service.rate(saved.item.itemId, "skip");
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.writes, 0);
  assert.equal((await service.listDue()).items.length, 0, "skip dismisses the item in this session");
  assert.equal(fixture.adapter.measured().writes, writesBeforeSkip);
  assert.deepEqual(await fixture.history.listBatches({ deviceIds: [fixture.coordinator.deviceId] }), batchesBeforeSkip,
    "skip creates no immutable History batch");

  const reopened = fixture.createService();
  assert.equal((await reopened.listDue()).items[0].itemId, saved.item.itemId,
    "a new service session has no inherited skip state");
  assert.deepEqual(await service.endReviewSession(), { status: "ended", dismissed: 1, writes: 0 });
  const afterEnd = await service.listDue();
  assert.equal(afterEnd.items[0].itemId, saved.item.itemId,
    "ending a session re-exposes unreviewed due items on the same service instance");
  assert.equal(afterEnd.items[0].state.reviewCount, 0);
  assert.equal(fixture.adapter.measured().writes, writesBeforeSkip);
  assert.deepEqual(await fixture.history.listBatches({ deviceIds: [fixture.coordinator.deviceId] }), batchesBeforeSkip);
});

test("Learning items survive runtime restart with state and immutable History available", async () => {
  const fixture = createFixture();
  const service = fixture.createService();
  const saved = await confirm(service, { actionId: "durable-confirm" });
  await service.rate(saved.item.itemId, "remember", { actionId: "durable-rating" });

  const restarted = fixture.createService();
  const item = await restarted.getItem(saved.item.itemId);
  assert.equal(item.reviewState.box, 2);
  assert.equal(item.lastReviewEvent.actionId, "durable-rating");
  assert.equal(item.lastReviewEvent.sequence, 1);
  assert.equal(item.lastReviewEvent.schedulerVersion, "leitner-utc-v1");
  assert.equal(item.lastReviewEvent.previousEventId, null);
  const batches = await fixture.history.listBatches({ deviceIds: [fixture.coordinator.deviceId] });
  assert.ok(batches.some((batch) => batch.actionKind === "learning-confirm"));
  assert.ok(batches.some((batch) => batch.actionKind === "learning-rating"));
  assert.ok(fixture.adapter.measured().filesTouched.some((path) => path.startsWith(`${LEARNING_ROOT}/`)));
  assert.equal(LEARNING_STORE_ID, "learning-items-v1");
});

test("Rating undo restores the event head, retains immutable events, and a new rating branches", async () => {
  const fixture = createFixture();
  const service = fixture.createService();
  const saved = await confirm(service, { actionId: "branch-confirm" });
  const first = await service.rate(saved.item.itemId, "remember", { actionId: "branch-rate-1" });
  const second = await service.rate(saved.item.itemId, "forget", { actionId: "branch-rate-2" });
  assert.equal(second.event.previousEventId, first.event.eventId);

  const ratingBatch = (await fixture.history.listBatches({ deviceIds: [fixture.coordinator.deviceId] }))
    .find((batch) => batch.actionKind === "learning-rating" &&
      batch.changes.some((change) => change.after?.actionId === "branch-rate-2"));
  assert.ok(ratingBatch);
  const restored = await fixture.runtime.exclusive(() => fixture.history.restore(ratingBatch.batchId));
  assert.equal(restored.status, "committed");
  const afterUndo = await service.getItem(saved.item.itemId);
  assert.equal(afterUndo.lastReviewEvent.eventId, first.event.eventId);
  assert.deepEqual(afterUndo.reviewState, first.state);

  const duplicate = await service.rate(saved.item.itemId, "forget", { actionId: "branch-rate-2" });
  assert.equal(duplicate.status, "duplicate", "direct immutable batch lookup keeps old action IDs idempotent after undo");
  assert.equal((await service.getItem(saved.item.itemId)).lastReviewEvent.eventId, first.event.eventId);
  const branch = await service.rate(saved.item.itemId, "forget", { actionId: "branch-rate-3" });
  assert.equal(branch.event.previousEventId, first.event.eventId);
  assert.equal(branch.event.sequence, 2);

  const exported = JSON.parse((await service.exportItems("json")).content);
  const events = exported.items[0].reviewHistory;
  assert.deepEqual(events.map((event) => event.actionId).sort(), ["branch-rate-1", "branch-rate-2", "branch-rate-3"]);
  assert.equal(events.find((event) => event.actionId === "branch-rate-2").onCurrentBranch, false);
  assert.equal(events.find((event) => event.actionId === "branch-rate-3").onCurrentBranch, true);
});

test("audit: export on another device retains immutable ratings and event ancestry", async () => {
  const first = createFixture({ deviceId: "device-a" });
  const service = first.createService();
  const saved = await confirm(service);
  const rated = await service.rate(saved.item.itemId, "remember", { actionId: "device-a-rating" });
  const second = createFixture({ adapter: first.adapter, deviceId: "device-b" });
  const exported = JSON.parse((await second.createService().exportItems("json")).content);
  assert.equal(exported.items[0].lastReviewEvent.eventId, rated.event.eventId);
  assert.deepEqual(exported.items[0].reviewHistory.map(event => event.eventId), [rated.event.eventId]);
});

test("Leitner scheduler matches the existing Review service UTC transitions", async () => {
  const fixture = createFixture();
  const scheduler = new LeitnerScheduler();
  const familyKey = 'en-family:v1:word:["learning-parity"]';
  let reviewTime = "2026-10-22T10:00:00.000Z";
  const vocabularyService = {
    async getFamilyByKey(key, options) {
      assert.deepEqual(options, { includeRecords: false });
      return key === familyKey ? { familyKey, type: "word", status: 1 } : undefined;
    },
  };
  const review = createVocabularyReviewService({
    transaction: fixture.coordinator,
    vocabularyService,
    now: () => new Date(reviewTime),
    makeId: () => "review-generated",
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  await review.openSession({ sessionId: "learning-parity" });
  const enrolled = await review.enroll(familyKey, { actionId: "parity-enroll" });
  let ownState = scheduler.initialState(enrolled.state.dueAt);
  assert.equal(enrolled.state.dueAt, ownState.dueAt);
  let date = Date.parse(reviewTime);
  for (let index = 0; index < 5; index += 1) {
    const ratedAt = new Date(date + index * 60_000).toISOString();
    fixture.setTime(ratedAt);
    reviewTime = ratedAt;
    const expected = scheduler.rate(ownState, "remember", ratedAt).state;
    const actual = (await review.remember(familyKey, { actionId: `parity-remember-${index}` })).state;
    ownState = expected;
    for (const field of ["box", "dueAt", "lastReviewedAt", "reviewCount", "lapseCount"]) assert.equal(actual[field], expected[field]);
  }
  assert.equal(ownState.box, 5);
  assert.deepEqual(LEITNER_INTERVAL_DAYS, [1, 3, 7, 14, 30]);
  const ratedAt = new Date(date + 10 * 60_000).toISOString();
  fixture.setTime(ratedAt);
  reviewTime = ratedAt;
  ownState = scheduler.rate(ownState, "forget", ratedAt).state;
  const forgotten = (await review.forget(familyKey, { actionId: "parity-forget" })).state;
  for (const field of ["box", "dueAt", "lastReviewedAt", "reviewCount", "lapseCount"]) assert.equal(forgotten[field], ownState[field]);
  await review.close();
});

test("Leitner scheduler exposes schedule, isDue, and a pure description projection", () => {
  const scheduler = new LeitnerScheduler();
  const initial = scheduler.initialState("2026-10-22T10:00:00.000Z");
  assert.deepEqual(scheduler.describe(initial), {
    version: "leitner-utc-v1", box: 1, dueAt: "2026-10-22T10:00:00.000Z", intervalDays: 1,
  });
  assert.equal(scheduler.isDue(initial, "2026-10-22T10:00:00.000Z"), true);
  const scheduled = scheduler.schedule(initial, "remember", "2026-10-22T10:00:00.000Z");
  assert.deepEqual(scheduled, scheduler.rate(initial, "remember", "2026-10-22T10:00:00.000Z"));
  assert.deepEqual(scheduler.describe(scheduled.state), {
    version: "leitner-utc-v1", box: 2, dueAt: "2026-10-25T10:00:00.000Z", intervalDays: 3,
  });
  assert.equal(scheduler.isDue(scheduled.state, "2026-10-25T10:00:00.000Z"), true);
});

test("Due paging is stable and bounded, skip writes nothing, and exports include stable source fields", async () => {
  const fixture = createFixture();
  const service = fixture.createService();
  const items = [];
  for (let index = 0; index < 5; index += 1) {
    items.push((await confirm(service, { prompt: `Question ${index}`, actionId: `page-confirm-${index}` })).item);
  }
  const firstPage = await service.listDue({ limit: 2 });
  const secondPage = await service.listDue({ limit: 2, cursor: firstPage.nextCursor });
  const finalPage = await service.listDue({ limit: 2, cursor: secondPage.nextCursor });
  const pageIds = [...firstPage.items, ...secondPage.items, ...finalPage.items].map((row) => row.itemId);
  assert.equal(new Set(pageIds).size, 5);
  assert.equal((await service.listDue({ limit: 101 }).catch((error) => error)).code, "LEARNING_PAGE_SIZE_INVALID");

  const beforeSkip = fixture.adapter.measured().writes;
  await service.rate(items[0].itemId, "skip");
  assert.equal(fixture.adapter.measured().writes, beforeSkip);
  assert.equal((await service.listDue()).total, 4);
  const afterRestart = fixture.createService();
  assert.equal((await afterRestart.listDue()).total, 5, "skip is session-local");

  const markdown = await service.exportItems("markdown");
  const csv = await service.exportItems("csv");
  const tsv = await service.exportItems("anki-tsv");
  assert.match(markdown.content, /obreader-learning:v1:/);
  assert.match(markdown.content, /Library\/Book\.pdf#page=2&obreader=ann\.annotation-1/);
  assert.doesNotMatch(markdown.content, /(?:docKey|obdoc)=/u);
  assert.match(csv.content, /ExternalID,Prompt,Answer,TargetText,SourceLink/);
  assert.match(tsv.content, /ExternalID\tPrompt\tAnswer\tTargetText\tSourceLink/);
  assert.equal(markdown.itemCount, 5);
});

test("Deterministic provider creates a draft without touching canonical storage", async () => {
  const fixture = createFixture();
  const service = fixture.createService();
  const provider = createDeterministicLearningProvider();
  const before = fixture.adapter.measured();
  const draft = await createDraftWithProvider({ service, provider, source: SOURCE });
  assert.equal(draft.answer, SOURCE.targetText);
  assert.match(draft.prompt, /Recall the meaning/);
  assert.deepEqual(provider.capabilities, LEARNING_ASSISTANT_CAPABILITIES);
  assert.deepEqual(provider.capabilities, ["explain", "translate", "generateQuestions", "generateCards", "summarize"]);
  for (const capability of provider.capabilities) {
    const result = await provider[capability]({ source: SOURCE });
    assert.equal(result.status, "draft", `${capability} remains a draft-only provider result`);
  }
  assert.deepEqual(fixture.adapter.measured(), before);
  service.cancelDraft(draft.draftId);
});

test("Markdown source rename moves soft provenance by exact folder prefix and undo restores paths only", async () => {
  const fixture = createFixture();
  const service = fixture.createService();
  const first = await confirm(service, {
    source: markdownSource("Notes/Old/Quote.md"), prompt: "What was quoted?", answer: "A quote",
    actionId: "rename-md-1",
  });
  const nested = await confirm(service, {
    source: markdownSource("Notes/Old/Nested/Quote.md", { offset: 2, text: "nested", line: 4 }),
    prompt: "Nested quote?", answer: "Nested answer", actionId: "rename-md-2",
  });
  const oldPrefixLookalike = await confirm(service, {
    source: markdownSource("Notes/Oldish/Quote.md", { offset: 1, text: "other", line: 2 }),
    prompt: "Other quote?", answer: "Other answer", actionId: "rename-md-3",
  });
  const pdf = await confirm(service, { actionId: "rename-md-pdf" });
  const rating = await service.rate(first.item.itemId, "remember", { actionId: "rename-md-rating" });
  const beforeWrites = fixture.adapter.measured().writes;

  const moved = await service.renameMarkdownSource("Notes/Old", "Notes/New", { actionId: "rename-md-folder" });
  assert.equal(moved.status, "committed");
  assert.equal(moved.movedItems, 2);
  assert.equal(fixture.adapter.measured().writes > beforeWrites, true);
  const renamedFirst = await service.getItem(first.item.itemId);
  const renamedNested = await service.getItem(nested.item.itemId);
  assert.equal(renamedFirst.externalId, first.item.externalId);
  assert.equal(renamedFirst.source.sourcePath, "Notes/New/Quote.md");
  assert.equal(renamedNested.source.sourcePath, "Notes/New/Nested/Quote.md");
  assert.equal(renamedFirst.lastReviewEvent.eventId, rating.event.eventId, "rename does not change the review event head");
  assert.equal((await service.getItem(oldPrefixLookalike.item.itemId)).source.sourcePath, "Notes/Oldish/Quote.md");
  assert.equal((await service.getItem(pdf.item.itemId)).source.sourcePath, SOURCE.sourcePath);

  const renameBatch = (await fixture.history.listBatches({ deviceIds: [fixture.coordinator.deviceId] }))
    .find((batch) => batch.actionKind === "learning-source-rename");
  assert.ok(renameBatch);
  const restored = await fixture.runtime.exclusive(() => fixture.history.restore(renameBatch.batchId));
  assert.equal(restored.status, "committed");
  assert.equal((await service.getItem(first.item.itemId)).source.sourcePath, "Notes/Old/Quote.md");
  assert.equal((await service.getItem(nested.item.itemId)).source.sourcePath, "Notes/Old/Nested/Quote.md");
  assert.equal((await service.getItem(first.item.itemId)).lastReviewEvent.eventId, rating.event.eventId,
    "undo restores source provenance without reverting rating state");
  assert.equal((await service.renameMarkdownSource("Notes/Old", "Notes/New", { actionId: "rename-md-folder" })).status,
    "already-undone");
  const redone = await fixture.runtime.exclusive(() => fixture.history.restore(restored.restoreBatchId));
  assert.equal(redone.status, "committed");
  assert.equal((await service.getItem(first.item.itemId)).source.sourcePath, "Notes/New/Quote.md",
    "redo restores the moved provenance through the same learning handler");
  assert.equal((await service.renameMarkdownSource("Notes/Old", "Notes/New", { actionId: "rename-md-folder" })).status,
    "duplicate");
  const exported = JSON.parse((await service.exportItems("json")).content);
  const sourceExport = exported.items.find((item) => item.itemId === first.item.itemId);
  assert.deepEqual(sourceExport.source.sourceRange, markdownSource("Notes/New/Quote.md").sourceRange,
    "JSON export preserves exact Markdown range evidence after rename and redo");
  assert.equal(sourceExport.sourceLink, "Notes/New/Quote.md (line 1)");
});
