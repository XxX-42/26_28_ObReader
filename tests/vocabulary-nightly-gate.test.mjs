import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_DURATION_MS, NIGHTLY_MATRIX, parseNightlyOptions } from "../scripts/test-vocabulary-nightly.mjs";

test("Vocabulary Nightly gate defaults to 30 minutes and exposes the complete ordered matrix", () => {
  assert.deepEqual(parseNightlyOptions([]), { help: false, durationMs: DEFAULT_DURATION_MS });
  assert.equal(DEFAULT_DURATION_MS, 30 * 60 * 1000);
  assert.deepEqual(NIGHTLY_MATRIX.map(({ id }) => id), ["lexical-scale", "large-transfer", "fast", "browser", "race"]);
  assert.ok(NIGHTLY_MATRIX[0].covers.some((entry) => entry.includes("25,000")));
  assert.ok(NIGHTLY_MATRIX[0].covers.some((entry) => entry.includes("12-token")));
});

test("Vocabulary Nightly gate accepts explicit diagnostic durations and rejects unsafe options", () => {
  assert.deepEqual(parseNightlyOptions(["--duration-ms=1200"]), { help: false, durationMs: 1200 });
  assert.deepEqual(parseNightlyOptions(["--duration-ms", "900"]), { help: false, durationMs: 900 });
  assert.equal(parseNightlyOptions(["--help"]).help, true);
  assert.throws(() => parseNightlyOptions(["--duration-ms=0"]), /positive safe integer/);
  assert.throws(() => parseNightlyOptions(["--duration-ms=9007199254740992"]), /positive safe integer/);
  assert.throws(() => parseNightlyOptions(["--unknown"]), /Unknown nightly stress option/);
});
