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
  // Some hand-built/imported Vault snapshots contain escaped line breaks
  // instead of real newlines. Normalize only at presentation time so the
  // stored user data is not rewritten or lost.
  const text = cleanText(value, 4096)
    .replace(/\\r\\n/gu, "\n")
    .replace(/\\n/gu, "\n")
    .replace(/\\r/gu, "\n")
    .replace(/\r\n?/gu, "\n");
  if (!text) return [];
  const hasSourceLines = /\n/u.test(text);
  const entries = text
    .split(/\n/u)
    .flatMap((line) => line.split(/\s*[;；]\s*/u));
  return entries
    .map((item) => item.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/u, "").trim())
    .filter(Boolean)
    // Preserve explicitly line-broken dictionary entries (including four-line
    // ECDICT records), while keeping inline semicolon lists compact.
    .slice(0, hasSourceLines ? 12 : 3);
}

/** Return only display-safe vocabulary fields; persistence metadata never reaches the pill. */
export function vocabularyEntryPresentation(record) {
  const pronunciation = cleanText(
    record?.phonetic || record?.ipa || record?.pronunciation,
    160,
  );
  const meanings = splitMeanings(record?.translation).map((meaning) =>
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
