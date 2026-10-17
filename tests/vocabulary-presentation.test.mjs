import assert from "node:assert/strict";
import test from "node:test";

import { vocabularyEntryPresentation } from "../viewer-adapter/vocabulary/presentation.js";

test("entry card presentation exposes only pronunciation, up to three short meanings, and learning status", () => {
  const view = vocabularyEntryPresentation({
    key: "move on",
    status: 5,
    translation: "继续前进；继续做；继续生活；第四条不应显示",
    phonetic: " /muːv ɒn/ ",
    note: "private note should not be displayed",
    source: "import",
    updatedAt: 12345,
    frequency: 999,
    internalId: "debug-key",
  });
  assert.equal(view.pronunciation, "/muːv ɒn/");
  assert.deepEqual(view.meanings, ["继续前进", "继续做", "继续生活"]);
  assert.equal(view.statusLabel, "已知");
  assert.equal(JSON.stringify(view).includes("private note"), false);
  assert.equal(JSON.stringify(view).includes("debug-key"), false);
  assert.equal(JSON.stringify(view).includes("12345"), false);
});

test("unavailable pronunciation and meaning stay compact and malformed statuses are hidden", () => {
  const view = vocabularyEntryPresentation({ translation: `释义${"很长".repeat(200)}`, status: 99 });
  assert.equal(view.pronunciation, "");
  assert.equal(view.meanings.length, 1);
  assert.ok(view.meanings[0].length <= 180);
  assert.equal(view.status, null);
  assert.equal(view.statusLabel, "未收录");
});
