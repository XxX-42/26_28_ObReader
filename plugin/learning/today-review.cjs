"use strict";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_FETCHES_PER_CALL = 100;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function reviewError(code, message) {
  const error = new Error(message);
  error.name = "TodayReviewError";
  error.code = code;
  return error;
}

function itemIdOf(providerId, item) {
  const value = providerId === "vocabulary" ? item?.familyKey : item?.itemId;
  return typeof value === "string" && value ? value : null;
}

function dueAtOf(item) {
  return typeof item?.dueAt === "string" ? item.dueAt : item?.state?.dueAt;
}

function compareRows(left, right) {
  return String(dueAtOf(left.item)).localeCompare(String(dueAtOf(right.item))) ||
    left.providerId.localeCompare(right.providerId) || left.itemId.localeCompare(right.itemId);
}

function normalizePageSize(value, fallback = DEFAULT_PAGE_SIZE) {
  const limit = value == null ? fallback : value;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw reviewError("TODAY_REVIEW_PAGE_SIZE_INVALID", `Today Review page size must be from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return limit;
}

function createTodayReviewAggregator({ vocabulary, learning, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const size = normalizePageSize(pageSize);
  const providers = [
    { id: "vocabulary", service: vocabulary },
    { id: "learning", service: learning },
  ];
  for (const entry of providers) {
    if (!entry.service || typeof entry.service.listDue !== "function") {
      throw new TypeError(`Today Review requires ${entry.id}.listDue().`);
    }
  }

  function openSession() {
    const state = new Map(providers.map(({ id }) => [id, {
      cursor: null, buffer: [], nextCursor: null, fetched: false, done: false, seenCursors: new Set(),
    }]));
    const emitted = new Set();
    let sessionGeneration = 0;
    let nextSerial = Promise.resolve();

    async function fill(providerId, generation, fetchCounts) {
      const entry = providers.find((candidate) => candidate.id === providerId);
      const current = state.get(providerId);
      if (current.buffer.length || current.done) return;
      if (current.fetched) current.cursor = current.nextCursor;
      if (current.fetched && !current.cursor) {
        current.done = true;
        return;
      }
      fetchCounts[providerId] = (fetchCounts[providerId] || 0) + 1;
      if (fetchCounts[providerId] > MAX_PAGE_FETCHES_PER_CALL) {
        throw reviewError("TODAY_REVIEW_PROVIDER_PAGE_INVALID", `${providerId}.listDue() exceeded the bounded page-fetch allowance.`);
      }
      const requestedCursor = current.cursor;
      const page = await entry.service.listDue({ limit: size, cursor: current.cursor });
      if (generation !== sessionGeneration) {
        throw reviewError("TODAY_REVIEW_SESSION_INVALIDATED", "Today Review changed while a provider page was loading; request the next page again.");
      }
      if (!page || !Array.isArray(page.items) || (page.nextCursor != null && typeof page.nextCursor !== "string")) {
        throw reviewError("TODAY_REVIEW_PROVIDER_PAGE_INVALID", `${providerId}.listDue() returned an invalid page.`);
      }
      if (page.items.length > size || (page.items.length === 0 && page.nextCursor != null) ||
          (page.nextCursor != null && (page.nextCursor === requestedCursor || current.seenCursors.has(page.nextCursor)))) {
        throw reviewError("TODAY_REVIEW_PROVIDER_PAGE_INVALID", `${providerId}.listDue() returned an oversized page or non-advancing cursor.`);
      }
      const normalized = page.items.map((item) => {
        const itemId = itemIdOf(providerId, item);
        const dueAt = dueAtOf(item);
        if (!itemId || typeof dueAt !== "string" || !ISO_UTC.test(dueAt) ||
            !Number.isFinite(Date.parse(dueAt)) || new Date(dueAt).toISOString() !== dueAt) {
          throw reviewError("TODAY_REVIEW_PROVIDER_ITEM_INVALID", `${providerId}.listDue() returned an item without a stable ID or dueAt.`);
        }
        return { providerId, itemId, dueAt, item };
      });
      const pageIds = new Set();
      for (let index = 0; index < normalized.length; index += 1) {
        const row = normalized[index];
        const key = `${row.providerId}\u0000${row.itemId}`;
        if (pageIds.has(key) || (index > 0 && compareRows(normalized[index - 1], row) > 0)) {
          throw reviewError("TODAY_REVIEW_PROVIDER_PAGE_INVALID", `${providerId}.listDue() returned duplicate or unsorted items.`);
        }
        pageIds.add(key);
      }
      if (page.nextCursor != null) current.seenCursors.add(page.nextCursor);
      current.buffer = normalized.filter((row) => !emitted.has(`${row.providerId}\u0000${row.itemId}`));
      current.nextCursor = page.nextCursor;
      current.fetched = true;
      if (!current.buffer.length && !current.nextCursor) current.done = true;
    }

    async function ensureHead(providerId, generation, fetchCounts) {
      const current = state.get(providerId);
      while (!current.buffer.length && !current.done) {
        if (generation !== sessionGeneration) {
          throw reviewError("TODAY_REVIEW_SESSION_INVALIDATED", "Today Review changed while loading; request the next page again.");
        }
        await fill(providerId, generation, fetchCounts);
      }
      return current.buffer[0] || null;
    }

    async function nextPageUnlocked({ limit } = {}) {
      const requested = normalizePageSize(limit, size);
      const generation = sessionGeneration;
      const fetchCounts = Object.create(null);
      const output = [];
      while (output.length < requested) {
        const heads = await Promise.all(providers.map(({ id }) => ensureHead(id, generation, fetchCounts)));
        if (generation !== sessionGeneration) {
          throw reviewError("TODAY_REVIEW_SESSION_INVALIDATED", "Today Review changed while loading; request the next page again.");
        }
        const candidates = heads.filter(Boolean);
        if (!candidates.length) break;
        candidates.sort(compareRows);
        const chosen = candidates[0];
        state.get(chosen.providerId).buffer.shift();
        emitted.add(`${chosen.providerId}\u0000${chosen.itemId}`);
        output.push(chosen);
      }
      if (generation !== sessionGeneration) {
        throw reviewError("TODAY_REVIEW_SESSION_INVALIDATED", "Today Review changed while loading; request the next page again.");
      }
      return {
        items: output,
        hasMore: [...state.values()].some((current) => current.buffer.length > 0 || current.nextCursor != null),
        cursor: Object.fromEntries(providers.map(({ id }) => {
          const current = state.get(id);
          return [id, { providerCursor: current.cursor, buffered: current.buffer.length, done: current.done }];
        })),
        generation: sessionGeneration,
      };
    }

    function nextPage(options = {}) {
      const pending = nextSerial.then(() => nextPageUnlocked(options));
      nextSerial = pending.catch(() => undefined);
      return pending;
    }

    async function rate(providerId, itemId, rating, options = {}) {
      const entry = providers.find((candidate) => candidate.id === providerId);
      if (!entry) throw reviewError("TODAY_REVIEW_PROVIDER_INVALID", `Unknown review provider ${providerId}.`);
      let result;
      if (providerId === "vocabulary") {
        const method = rating === "remember" ? "remember" : rating === "forget" ? "forget" : rating === "skip" ? "skip" : null;
        if (!method || typeof entry.service[method] !== "function") {
          throw reviewError("TODAY_REVIEW_RATING_INVALID", `Vocabulary does not support rating ${rating}.`);
        }
        result = await entry.service[method](itemId, options);
      } else {
        if (typeof entry.service.rate !== "function") throw reviewError("TODAY_REVIEW_RATING_UNAVAILABLE", "Learning provider does not expose rate().");
        result = await entry.service.rate(itemId, rating, options);
      }
      invalidate();
      return result;
    }

    function invalidate() {
      sessionGeneration += 1;
      // Items merely shown to the UI are not completed. After a rating, re-read
      // providers from the start; rated/skipped rows leave through provider state.
      emitted.clear();
      for (const current of state.values()) {
        current.cursor = null;
        current.buffer = [];
        current.nextCursor = null;
        current.fetched = false;
        current.done = false;
        current.seenCursors.clear();
      }
    }

    return Object.freeze({ nextPage, rate, invalidate });
  }

  return Object.freeze({ openSession, pageSize: size });
}

module.exports = { createTodayReviewAggregator, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE };
