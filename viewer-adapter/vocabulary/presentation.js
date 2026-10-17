const STATUS_LABELS = Object.freeze({
  1: "新词",
  2: "学习中",
  3: "复习中",
  4: "已掌握",
  5: "已知",
});

function cleanText(value, limit = 512) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim().slice(0, limit);
}

function splitMeanings(value) {
  const text = cleanText(value, 4096);
  if (!text) return [];
  return text
    .split(/\r?\n|\s*[;；]\s*/u)
    .map((item) => item.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/u, "").trim())
    .filter(Boolean);
}

/** Return only display-safe vocabulary fields; persistence metadata never reaches the pill. */
export function vocabularyEntryPresentation(record) {
  const pronunciation = cleanText(
    record?.phonetic || record?.ipa || record?.pronunciation,
    160,
  );
  const meanings = splitMeanings(record?.translation).slice(0, 3).map((meaning) =>
    meaning.length > 180 ? `${meaning.slice(0, 179).trimEnd()}…` : meaning,
  );
  const status = Number.isInteger(record?.status) && record.status >= 1 && record.status <= 5
    ? record.status
    : null;
  return Object.freeze({
    pronunciation,
    meanings: Object.freeze(meanings),
    status,
    statusLabel: status === null ? "未收录" : STATUS_LABELS[status],
  });
}

export function vocabularyStatusLabel(status) {
  return STATUS_LABELS[status] || "未收录";
}
