import assert from "node:assert/strict";
import test from "node:test";

import { vocabularyEntryPresentation, vocabularyStatusLabel } from "../viewer-adapter/vocabulary/presentation.js";

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
  assert.equal(view.statusLabel, "学习状态未设置");
  assert.equal(vocabularyStatusLabel(99), "学习状态未设置");
});

test("missing personal learning state is distinct from an unqueried dictionary", () => {
  const absentRecord = vocabularyEntryPresentation(null);
  assert.equal(absentRecord.hasPersonalRecord, false);
  assert.equal(absentRecord.statusLabel, "无个人学习状态");
  assert.equal(absentRecord.meaningState, "external-dictionary-not-queried");
  assert.equal(absentRecord.meaningFallbackLabel, "未查询外部词典");

  const emptyPersonalRecord = vocabularyEntryPresentation({ key: "on", type: "word" });
  assert.equal(emptyPersonalRecord.hasPersonalRecord, true);
  assert.equal(emptyPersonalRecord.statusLabel, "学习状态未设置");
  assert.equal(emptyPersonalRecord.meaningState, "not-saved-in-personal-record");
  assert.equal(emptyPersonalRecord.meaningFallbackLabel, "个人词条未保存释义");
});

test("escaped dictionary line breaks are rendered as separate meanings", () => {
  const view = vocabularyEntryPresentation({
    translation: "adv. 大概, 大部分, 主要\\n[经] 大部份",
  });
  assert.deepEqual(view.meanings, ["adv. 大概, 大部分, 主要", "[经] 大部份"]);
});

test("real dictionary line breaks preserve all four part-of-speech entries", () => {
  const view = vocabularyEntryPresentation({
    translation: "n. 细节, 详情\nvt. 详述, 选派\nvi. 画详图\n[计] 详细数据",
  });
  assert.deepEqual(view.meanings, [
    "n. 细节, 详情",
    "vt. 详述, 选派",
    "vi. 画详图",
    "[计] 详细数据",
  ]);
  assert.deepEqual(vocabularyEntryPresentation({
    translation: "n. 细节, 详情\r\nvt. 详述, 选派\rvi. 画详图",
  }).meanings, ["n. 细节, 详情", "vt. 详述, 选派", "vi. 画详图"],
    "CRLF and CR-only dictionary exports normalize to the same display lines");
});
