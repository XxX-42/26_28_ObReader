"use strict";

const LEITNER_INTERVAL_DAYS = Object.freeze([1, 3, 7, 14, 30]);
const LEITNER_SCHEDULER_VERSION = "leitner-utc-v1";
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function schedulerError(code, message) {
  const error = new Error(message);
  error.name = "LearningSchedulerError";
  error.code = code;
  return error;
}

function parseUtc(value, name) {
  if (typeof value !== "string" || !ISO_UTC.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) {
    throw schedulerError("LEARNING_TIME_INVALID", `${name} must be a valid UTC ISO timestamp.`);
  }
  return Date.parse(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function validateState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state) ||
      !Number.isInteger(state.box) || state.box < 1 || state.box > LEITNER_INTERVAL_DAYS.length ||
      !Number.isSafeInteger(state.reviewCount) || state.reviewCount < 0 ||
      !Number.isSafeInteger(state.lapseCount) || state.lapseCount < 0 ||
      !(state.lastReviewedAt === null || typeof state.lastReviewedAt === "string")) {
    throw schedulerError("LEARNING_SCHEDULE_INVALID", "The learning schedule state is malformed.");
  }
  parseUtc(state.dueAt, "dueAt");
  if (state.lastReviewedAt !== null) parseUtc(state.lastReviewedAt, "lastReviewedAt");
  return state;
}

class LeitnerScheduler {
  constructor() {
    this.version = LEITNER_SCHEDULER_VERSION;
    Object.freeze(this);
  }

  initialState(createdAtUTC) {
    parseUtc(createdAtUTC, "createdAtUTC");
    return { box: 1, dueAt: createdAtUTC, lastReviewedAt: null, reviewCount: 0, lapseCount: 0 };
  }

  rate(state, rating, reviewedAtUTC) {
    validateState(state);
    const reviewedAtMs = parseUtc(reviewedAtUTC, "reviewedAtUTC");
    if (rating === "skip") return { changed: false, state: clone(state) };
    if (rating !== "remember" && rating !== "forget") {
      throw schedulerError("LEARNING_RATING_INVALID", "Rating must be remember, forget, or skip.");
    }
    const box = rating === "remember" ? Math.min(LEITNER_INTERVAL_DAYS.length, state.box + 1) : 1;
    const days = rating === "remember" ? LEITNER_INTERVAL_DAYS[box - 1] : LEITNER_INTERVAL_DAYS[0];
    const next = {
      box,
      dueAt: new Date(reviewedAtMs + days * 24 * 60 * 60 * 1000).toISOString(),
      lastReviewedAt: reviewedAtUTC,
      reviewCount: state.reviewCount + 1,
      lapseCount: state.lapseCount + (rating === "forget" ? 1 : 0),
    };
    validateState(next);
    return { changed: true, state: next };
  }

  schedule(state, rating, nowUTC) {
    return this.rate(state, rating, nowUTC);
  }

  isDue(state, atUTC) {
    validateState(state);
    parseUtc(atUTC, "atUTC");
    return state.dueAt <= atUTC;
  }

  describe(state) {
    validateState(state);
    return {
      version: this.version,
      box: state.box,
      dueAt: state.dueAt,
      intervalDays: LEITNER_INTERVAL_DAYS[state.box - 1],
    };
  }
}

module.exports = { LEITNER_INTERVAL_DAYS, LEITNER_SCHEDULER_VERSION, LeitnerScheduler };
