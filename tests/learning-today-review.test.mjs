import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createTodayReviewAggregator } = require("../plugin/learning/today-review.cjs");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("today review merges stable provider order with one page buffer per provider", async () => {
  const calls = { vocabulary: [], learning: [] };
  const provider = (id, rows) => ({
    async listDue({ limit, cursor }) {
      calls[id].push({ limit, cursor });
      const offset = cursor ? Number(cursor) : 0;
      const page = rows.slice(offset, offset + limit);
      return { items: page, nextCursor: offset + limit < rows.length ? String(offset + limit) : null };
    },
  });
  const vocabulary = provider("vocabulary", [
    { familyKey: "v-1", dueAt: "2026-10-22T09:00:00.000Z" },
    { familyKey: "v-2", dueAt: "2026-10-22T10:00:00.000Z" },
  ]);
  const learning = provider("learning", [
    { itemId: "l-1", dueAt: "2026-10-22T09:00:00.000Z" },
    { itemId: "l-2", dueAt: "2026-10-22T11:00:00.000Z" },
  ]);
  const session = createTodayReviewAggregator({ vocabulary, learning, pageSize: 1 }).openSession();
  const first = await session.nextPage({ limit: 2 });
  assert.deepEqual(first.items.map((row) => `${row.providerId}:${row.itemId}`), ["learning:l-1", "vocabulary:v-1"]);
  assert.ok(calls.vocabulary.length <= 2, "at most one next page is fetched after consuming a buffer");
  assert.ok(calls.learning.length <= 2);
  const rest = await session.nextPage({ limit: 2 });
  assert.deepEqual(rest.items.map((row) => `${row.providerId}:${row.itemId}`), ["vocabulary:v-2", "learning:l-2"]);
});
test("invalidate during a delayed provider page rejects stale results and the next call reloads", async () => {
  const firstPage = deferred();
  let calls = 0;
  const vocabulary = {
    listDue() {
      calls += 1;
      if (calls === 1) return firstPage.promise;
      return Promise.resolve({ items: [{ familyKey: "fresh", dueAt: "2026-10-22T10:00:00.000Z" }], nextCursor: null });
    },
  };
  const learning = { async listDue() { return { items: [], nextCursor: null }; } };
  const session = createTodayReviewAggregator({ vocabulary, learning, pageSize: 10 }).openSession();
  const stale = session.nextPage({ limit: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  session.invalidate();
  firstPage.resolve({ items: [{ familyKey: "stale", dueAt: "2026-10-22T09:00:00.000Z" }], nextCursor: null });
  await assert.rejects(stale, (error) => error.code === "TODAY_REVIEW_SESSION_INVALIDATED");
  const fresh = await session.nextPage({ limit: 1 });
  assert.deepEqual(fresh.items.map((row) => row.itemId), ["fresh"]);
  assert.equal(calls, 2);
});

test("rating one item after a visible page keeps unreviewed visible items in the refreshed session", async () => {
  let rows = [
    { itemId: "l-1", dueAt: "2026-10-22T09:00:00.000Z" },
    { itemId: "l-2", dueAt: "2026-10-22T10:00:00.000Z" },
  ];
  const learning = {
    async listDue({ limit, cursor }) {
      const offset = cursor ? Number(cursor) : 0;
      const page = rows.slice(offset, offset + limit);
      return { items: page, nextCursor: offset + limit < rows.length ? String(offset + limit) : null };
    },
    async rate(itemId) {
      rows = rows.filter((row) => row.itemId !== itemId);
      return { status: "committed", itemId };
    },
  };
  const vocabulary = { async listDue() { return { items: [], nextCursor: null }; } };
  const session = createTodayReviewAggregator({ vocabulary, learning, pageSize: 10 }).openSession();
  const visible = await session.nextPage({ limit: 2 });
  assert.deepEqual(visible.items.map((row) => row.itemId), ["l-1", "l-2"]);
  await session.rate("learning", "l-1", "remember", { actionId: "rate-l-1" });
  const refreshed = await session.nextPage({ limit: 2 });
  assert.deepEqual(refreshed.items.map((row) => row.itemId), ["l-2"],
    "a displayed-but-unreviewed item must not disappear when the scored item invalidates pagination");
});

test("invalid provider pages fail closed instead of looping on empty or repeated cursors", async () => {
  const looping = { async listDue() { return { items: [], nextCursor: "same" }; } };
  const empty = { async listDue() { return { items: [], nextCursor: null }; } };
  const session = createTodayReviewAggregator({ vocabulary: looping, learning: empty, pageSize: 10 }).openSession();
  await assert.rejects(session.nextPage({ limit: 1 }), (error) => error.code === "TODAY_REVIEW_PROVIDER_PAGE_INVALID");

  const oversized = {
    async listDue() {
      return { items: Array.from({ length: 2 }, (_, index) => ({ familyKey: `v-${index}`, dueAt: "2026-10-22T10:00:00.000Z" })), nextCursor: null };
    },
  };
  const bounded = createTodayReviewAggregator({ vocabulary: oversized, learning: empty, pageSize: 1 }).openSession();
  await assert.rejects(bounded.nextPage({ limit: 1 }), (error) => error.code === "TODAY_REVIEW_PROVIDER_PAGE_INVALID");
});
